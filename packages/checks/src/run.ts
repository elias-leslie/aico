// Runs planned steps: a few at a time at low priority, each with a timeout, its output kept in
// .dev-tools/<id>-<pid>-details.txt, one result line per step. A declared stage runs in a clean
// environment (no credentials, offline package managers, PATH = its declared tools and paths);
// a legacy tool runs in the caller's. A full-gate stage with `inputs` reuses its last pass while
// those paths are unchanged.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, setPriority, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { SaxesParser } from 'saxes'
import { blobIds, commonDir, git } from './git'
import type { Config, Evidence, Lane, Planned, Step } from './plan'
import { missingLegacySkip, toolBinary, toolDir } from './plan'

export type StepState = 'pass' | 'fail' | 'skip' | 'timeout' | 'unavailable'

export interface StepResult {
  inputs?: { paths: string[]; key: string }
  id: string
  state: StepState
  ms: number
  required: boolean
  reused?: boolean
  reason?: string
  hint?: string
  /** On failure, the lines past the hint worth printing with the result. */
  failures?: string[]
  details?: string
}

export interface RunOptions {
  /** Steps at once (default 3). */
  jobs?: number
  /** Print one line per result as it lands. */
  out?: (line: string) => void
  /** Reuse a full-gate stage's pass while its inputs are unchanged (default true). */
  reuse?: boolean
  /** Where .dev-tools/ details go (default the checked tree; acceptance keeps them in the main checkout). */
  detailsRoot?: string
  /** Caller env, or the complete scrubbed acceptance env when cleanEnvironment is true. */
  env?: NodeJS.ProcessEnv
  cleanEnvironment?: boolean
}

const MAX_OUTPUT = 4 * 1024 * 1024

/** The clean environment a declared stage runs in (what `st check` gives native stages). */
function stageEnv(config: Config, aliases: string, scratch: string): NodeJS.ProcessEnv {
  const { root } = config
  const local = (path: string) => (isAbsolute(path) ? path : join(root, path))
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    LANG: 'C.UTF-8',
    CI: 'true',
    XDG_CONFIG_HOME: join(aliases, 'config'),
    XDG_DATA_HOME: join(aliases, 'data'),
    XDG_CACHE_HOME: join(aliases, 'cache'),
    XDG_STATE_HOME: join(aliases, 'state'),
    ...config.environment,
    TMPDIR: scratch,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPYCACHEPREFIX: join(aliases, 'pycache'),
    UV_NO_SYNC: '1',
    UV_OFFLINE: '1',
    CARGO_NET_OFFLINE: 'true',
    GOTOOLCHAIN: 'local',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    npm_config_offline: 'true',
    COREPACK_ENABLE_NETWORK: '0',
    PATH: [join(aliases, 'bin'), ...config.paths.map(local)].join(':'),
  }
  if (process.env.ST_CHECK_SEED) env.ST_CHECK_SEED = process.env.ST_CHECK_SEED
  return env
}

/** The tool links on a stage's PATH (`~/` is this account's home). */
function linkTools(config: Config, aliases: string): void {
  mkdirSync(join(aliases, 'bin'), { recursive: true, mode: 0o700 })
  for (const [name, target] of Object.entries(config.tools)) {
    const path = target.startsWith('~/') ? join(homedir(), target.slice(2)) : target
    symlinkSync(isAbsolute(path) ? path : join(config.root, path), join(aliases, 'bin', name))
  }
}

/** A stage's argv[0]: a declared tool, a project path, or the first native.paths hit. */
function executable(config: Config, command: string): string {
  if (command in config.tools) return command
  if (command.includes('/')) return isAbsolute(command) ? command : join(config.root, command)
  for (const dir of config.paths) {
    const path = join(isAbsolute(dir) ? dir : join(config.root, dir), command)
    if (existsSync(path)) return path
  }
  return command
}

const FAILURE_LINE =
  /\berror\b|\bFAIL(ED)?\b|Error:|✗|×|Found \d+ errors?|^--> |━━|^[A-Z]+\d+ |^[\w./@-]+\.\w+[:(]\d+/
/** Enough for most failures to be read here, without a second turn for the details file. */
const FAILURE_LINES = 8
const LINE_CHARS = 200
const FIXABLE = /\bFIXABLE\b|\[\*\]|Formatter would have/

function outputLines(output: string): string[] {
  return (
    output
      .split('\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
      .filter(Boolean)
  )
}

/** The line a reader needs first: an error line on failure, else the last line. */
function hint(output: string, failed: boolean): string {
  const lines = outputLines(output)
  const pick = failed
    ? (lines.find((line) => /\berror\b|\bFAIL(ED)?\b|Error:|✗|×|Found \d+ errors?/.test(line)) ??
      lines.at(-1))
    : (lines.findLast((line) => /\b(passed|no fixes|checked|ok)\b/i.test(line)) ?? lines.at(-1))
  return (pick ?? '-').slice(0, LINE_CHARS)
}

/** What failed, past the hint: the failing lines, or the output's end if none look like one. */
export function failureLines(output: string, shown: string): string[] {
  const lines = outputLines(output).filter((line) => !line.startsWith('$ '))
  const failing = lines.filter((line) => FAILURE_LINE.test(line))
  const unique = [
    ...new Set(
      (failing.length ? failing : lines.slice(-FAILURE_LINES)).map((line) =>
        line.replace(/\s*━+$/, '').slice(0, LINE_CHARS),
      ),
    ),
  ].filter((line) => line !== shown)
  const kept = unique.slice(0, FAILURE_LINES)
  if (unique.length > kept.length) kept.push(`${unique.length - kept.length} more in the details`)
  if (FIXABLE.test(output)) kept.push('Biome and ruff can fix your own files: st check --fix')
  return kept
}

const pyRegExp = (pattern: string) => new RegExp(pattern.replace(/\(\?P</g, '(?<'), 'gm')

/** Counts from a stage's evidence; failures fail it, and a test stage that ran nothing is unavailable. */
export function judge(
  kind: 'check' | 'test',
  ev: Evidence,
  content: string,
): { state: StepState; reason?: string } {
  let executed = 0
  let failed = 0
  let skipped = 0
  let exempt = 0
  if (ev.format === 'text') {
    if (!pyRegExp(ev.success_pattern ?? '').test(content))
      return { state: 'fail', reason: 'text evidence lacks its success marker' }
    executed = content.match(pyRegExp(ev.executed_pattern ?? '$^'))?.length ?? 0
    failed = content.match(pyRegExp(ev.failure_pattern ?? '$^'))?.length ?? 0
  } else if (ev.format === 'json') {
    const value: unknown = JSON.parse(content)
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('JSON evidence must contain nonnegative integer passed/failed/skipped counts')
    const counts = value as Record<string, unknown>
    for (const key of ['passed', 'failed', 'skipped'])
      if (typeof counts[key] !== 'number' || !Number.isInteger(counts[key]) || counts[key] < 0)
        throw new Error(
          'JSON evidence must contain nonnegative integer passed/failed/skipped counts',
        )
    executed = (counts.passed as number) + (counts.failed as number)
    failed = counts.failed as number
    skipped = counts.skipped as number
  } else if (ev.format === 'junit') {
    const parser = new SaxesParser({ xmlns: true })
    const stack: string[] = []
    let current: { skipped: boolean; failed: boolean } | null = null
    parser.on('opentag', (tag) => {
      const parent = stack.at(-1)
      stack.push(tag.local)
      if (tag.local === 'testcase' && parent === 'testsuite')
        current = { skipped: false, failed: false }
      else if (current && parent === 'testcase') {
        if (tag.local === 'skipped') current.skipped = true
        if (tag.local === 'failure' || tag.local === 'error') current.failed = true
      }
    })
    parser.on('closetag', () => {
      if (stack.pop() === 'testcase' && current) {
        if (current.skipped) skipped++
        else executed++
        if (current.failed) failed++
        current = null
      }
    })
    parser.write(content).close()
  } else {
    for (const line of content.split('\n')) {
      if (!line.trim().startsWith('{')) continue
      const event = JSON.parse(line) as { Test?: string; Action?: string; Package?: string }
      if (event.Action === 'fail') failed++
      if (!event.Test || !['pass', 'fail', 'skip'].includes(event.Action ?? '')) continue
      if (event.Action === 'skip') {
        skipped++
        if (ev.not_applicable_tests?.[`${event.Package ?? ''}.${event.Test}`]) exempt++
      } else executed++
    }
  }
  if (failed) return { state: 'fail', reason: 'evidence_records_failures' }
  if (kind === 'test' && (!executed || skipped > exempt))
    return { state: 'unavailable', reason: 'empty_or_skipped_required_tests' }
  return { state: 'pass' }
}

/** The reuse key of a stage with inputs: its declaration plus the content of its inputs. */
function inputsKey(config: Config, step: Step): string | null {
  const decl = step.decl
  if (!decl?.inputs.length) return null
  const { root } = config
  const hash = createHash('sha256').update(JSON.stringify([decl, step.argv]))
  hash.update(sourceKey(root, decl.inputs))
  return hash.digest('hex').slice(0, 32)
}

/** Effective working-tree content, stable across another lane committing the same bytes. */
export function sourceKey(root: string, paths: string[]): string {
  const hash = createHash('sha256')
  const files = [
    ...new Set(
      git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths])
        .split('\0')
        .filter(Boolean),
    ),
  ].sort()
  for (const [file, id] of blobIds(root, files)) hash.update(`${file}\0${id}\n`)
  return hash.digest('hex')
}

function spawnStep(
  config: Config,
  step: Step,
  env: NodeJS.ProcessEnv,
  argv: string[],
): Promise<{ code: number | null; output: string; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = ''
    let stdout = ''
    let timedOut = false
    const child = spawn(argv[0], argv.slice(1), {
      cwd: join(config.root, step.cwd),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    try {
      if (child.pid) setPriority(child.pid, 10)
    } catch {}
    const take = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8')
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8')
      take(chunk)
    })
    child.stderr.on('data', take)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, step.timeoutS * 1000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, output: `${output}${error.message}\n`, stdout, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, stdout, timedOut })
    })
  })
}

export function resultLine(result: StepResult): string {
  const state = { pass: 'OK', fail: 'FAIL', skip: 'SKIP', timeout: 'FAIL', unavailable: 'FAIL' }[
    result.state
  ]
  if (result.state === 'skip') return `CHECK:SKIP:${result.id}:${result.reason}`
  const parts = [`CHECK:${state}:${result.id}`, `${(result.ms / 1000).toFixed(1)}s`]
  if (result.reused) parts.push('reused')
  if (!result.required) parts.push('optional')
  if (result.reason) parts.push(result.reason)
  if (result.details) parts.push(`details:${result.details}`)
  if (result.hint) parts.push(`hint:${result.hint}`)
  return [parts.join('|'), ...(result.failures ?? []).map((line) => `  ${line}`)].join('\n')
}

/** Runs the planned steps; skipped ones come back as skip results in plan order. */
export async function runSteps(
  config: Config,
  lane: Lane,
  planned: Planned[],
  options: RunOptions = {},
): Promise<StepResult[]> {
  const { root } = config
  const out = options.out ?? (() => {})
  const results = new Map<string, StepResult>()
  for (const item of planned)
    if (item.skip) {
      const result: StepResult = {
        id: item.id,
        state: 'skip',
        ms: 0,
        required: false,
        reason: item.skip,
      }
      results.set(item.id, result)
    }
  const skipped = new Map<string, string[]>()
  for (const result of results.values())
    skipped.set(result.reason as string, [
      ...(skipped.get(result.reason as string) ?? []),
      result.id,
    ])
  // Path-scoped skips are the common case and only a count helps; other reasons name each check.
  for (const [reason, ids] of skipped)
    out(
      reason === 'no_relevant_changed_paths'
        ? `CHECK:SKIP:${reason}: ${ids.length} check(s)`
        : `CHECK:SKIP:${reason}: ${ids.join(', ')}`,
    )
  const steps = planned.flatMap((item) => (item.step ? [item.step] : []))
  if (!steps.length) return planned.map((item) => results.get(item.id) as StepResult)

  const work = mkdtempSync(join(tmpdir(), 'aico-check-'))
  const aliases = join(work, 'tools')
  linkTools(config, aliases)
  const details = join(options.detailsRoot ?? root, '.dev-tools')
  mkdirSync(details, { recursive: true })
  const passes = join(commonDir(root), 'aico-checks', 'stages')
  const reuse = options.reuse !== false && lane === 'full'

  const one = async (step: Step): Promise<StepResult> => {
    const required = lane === 'quick' || step.required
    // quick_paths selects when a stage runs; only inputs declares what its proof depends on.
    const inputPaths = step.decl?.inputs
    const boundPaths = inputPaths?.length ? [...new Set(inputPaths)] : undefined
    const inputs = boundPaths ? { paths: boundPaths, key: sourceKey(root, boundPaths) } : undefined
    const key = reuse ? inputsKey(config, step) : null
    const marker = key && join(passes, `${step.id}-${key}.json`)
    if (marker && existsSync(marker))
      return {
        id: step.id,
        state: 'pass',
        ms: 0,
        required,
        reused: true,
        inputs,
        hint: 'inputs unchanged since its last pass',
      }
    const scratch = mkdtempSync(join(work, `${step.id}-`))
    let argv =
      step.env === 'stage' ? [executable(config, step.argv[0]), ...step.argv.slice(1)] : step.argv
    if (step.materialize) {
      const dir = join(scratch, 'files')
      for (const file of step.materialize) {
        // Regular files only: a scanner reads content, never a link into another tree.
        if (!lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile()) continue
        mkdirSync(dirname(join(dir, file)), { recursive: true })
        copyFileSync(join(root, file), join(dir, file))
      }
      argv = argv.map((arg) => (arg === '{dir}' ? dir : arg))
    }
    const tool = step.id === 'frontend-test' ? 'vitest' : step.id
    const binary = toolBinary(config, tool, tool === 'types' ? 'ty' : tool, toolDir(root, tool))
    const toolPath = binary.includes('/') ? dirname(binary) : undefined
    const user = options.cleanEnvironment ? { ...options.env } : { ...process.env, ...options.env }
    const env =
      step.env === 'stage'
        ? stageEnv(config, aliases, scratch)
        : {
            ...user,
            CI: 'true',
            ...(toolPath ? { PATH: `${toolPath}:${user.PATH ?? ''}` } : {}),
            ...(['vitest', 'frontend-test'].includes(step.id) ? { NODE_ENV: 'test' } : {}),
          }
    if (step.scope && step.env === 'stage') {
      writeFileSync(join(scratch, 'scope'), step.scope.map((file) => `${file}\n`).join(''))
      env.CHECK_SCOPE_FILE = join(scratch, 'scope')
    }
    const report =
      step.decl?.evidence?.source === 'file' ? join(root, step.decl.evidence.path as string) : null
    if (report) rmSync(report, { force: true })
    const started = performance.now()
    let run = { code: 0 as number | null, output: '', stdout: '', timedOut: false }
    for (const command of [...(step.setup ?? []), argv]) {
      const result = await spawnStep(config, step, env, command)
      run = {
        ...result,
        output: `${run.output}${result.output}`,
        stdout: `${run.stdout}${result.stdout}`,
      }
      if (result.code !== 0 || result.timedOut) break
    }
    const ms = performance.now() - started
    const file = join(details, `${step.id}-${process.pid}-details.txt`)
    writeFileSync(file, `$ ${argv.join(' ')}\n${run.output}`)
    let state: StepState = run.timedOut
      ? 'timeout'
      : run.code === 0
        ? 'pass'
        : run.code === null
          ? 'unavailable'
          : 'fail'
    let because: string | undefined
    if (
      state === 'unavailable' &&
      /\bENOENT\b/.test(run.output) &&
      !(config.acceptance?.pytest && step.id === 'pytest')
    ) {
      const skip = missingLegacySkip(config, step.id)
      if (skip) {
        state = 'skip'
        because = skip
      }
    }
    if (step.decl?.evidence && state === 'pass') {
      const ev = step.decl.evidence
      let verdict: { state: StepState; reason?: string }
      try {
        const content =
          ev.source === 'file'
            ? readFileSync(report as string, 'utf8')
            : ev.source === 'stdout'
              ? run.stdout
              : run.output
        verdict = judge(step.decl.kind, ev, content)
      } catch (error) {
        verdict = {
          state: 'unavailable',
          reason: `evidence unreadable: ${(error as Error).message}`,
        }
      }
      state = verdict.state
      because = verdict.reason
    }
    if (state === 'pass' && inputs && sourceKey(root, inputs.paths) !== inputs.key) {
      state = 'fail'
      because = 'source_changed_during_checks: stage inputs changed'
    }
    if (state === 'pass' && marker) {
      mkdirSync(passes, { recursive: true })
      writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), ms: Math.round(ms) }))
    }
    rmSync(scratch, { recursive: true, force: true })
    const firstLine = hint(run.output, state !== 'pass')
    return {
      id: step.id,
      state,
      ms,
      required,
      inputs,
      reason: state === 'timeout' ? `timed out after ${step.timeoutS}s` : because,
      details: `.dev-tools/${step.id}-${process.pid}-details.txt`,
      hint: firstLine,
      ...(state === 'pass' ? {} : { failures: failureLines(run.output, firstLine) }),
    }
  }

  try {
    const queue = [...steps]
    const lanes = Array.from({ length: Math.min(options.jobs ?? 3, queue.length) }, async () => {
      for (let step = queue.shift(); step; step = queue.shift()) {
        let result: StepResult
        try {
          result = await one(step)
        } catch (error) {
          result = {
            id: step.id,
            state: 'unavailable',
            ms: 0,
            required: lane === 'quick' || step.required,
            reason: (error as Error).message,
          }
        }
        results.set(step.id, result)
        out(resultLine(result))
      }
    })
    await Promise.all(lanes)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return planned.map((item) => results.get(item.id) as StepResult)
}

/** Whether a run passed: every required step that ran passed. */
export function passed(results: StepResult[]): boolean {
  return results.every(
    (result) => !result.required || result.state === 'pass' || result.state === 'skip',
  )
}

/** A stored result keyed by what was checked, under the repo's shared .git (all worktrees see it). */
export function receiptStore(root: string) {
  const dir = join(commonDir(root), 'aico-checks', 'receipts')
  const path = (key: string) => join(dir, `${key}.json`)
  return {
    get<T>(key: string): T | null {
      try {
        return JSON.parse(readFileSync(path(key), 'utf8')) as T
      } catch {
        return null
      }
    },
    put(key: string, value: unknown): void {
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${path(key)}.tmp`, JSON.stringify(value, null, 1))
      // rename is atomic: a reader never sees half a receipt.
      renameSync(`${path(key)}.tmp`, path(key))
    },
  }
}
