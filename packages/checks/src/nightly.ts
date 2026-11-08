// `aico nightly [--source ID]`: the nightly deep lane (the check-nightly job). The full gate on
// HEAD in a clean worktree with nothing reused, so its wall time is the real cost, then the repo's
// `[[deep.stages]]` (live session checks) in a fresh worktree of the same commit (nobody's
// uncommitted edits count) with the caller's environment plus AICO_MAIN_CHECKOUT (the main checkout).
// The last line is the job's Status row: the gate time next to the previous night's, the slowest
// stages and what failed. Exit 1 when anything failed, so the row turns failed and alerts.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { openTasksDb, Registry, tasksDbPathFromEnv } from '@aico/tasks'
import { accept, withWorktree } from './accept'
import { git } from './git'
import { type Coordination, hookCoordination } from './hook'
import { type Config, ConfigError, loadConfig } from './plan'
import { receiptStore, type StepResult } from './run'
import { parseToml, type TomlTable } from './toml'

export interface DeepStage {
  id: string
  argv: string[]
  timeoutS: number
}

export interface DeepResult {
  id: string
  passed: boolean
  ms: number
  /** Why it failed: its last FAIL/error line, else its last output line. */
  last: string
}

export interface GateResult {
  passed: boolean
  ms: number
  sha?: string
  results: StepResult[]
  /** Why the gate did not run (a hold, a broken config). */
  refused?: string
}

/** The `[[deep.stages]]` of the repo's .st-check.toml. */
export function deepStages(root: string): DeepStage[] {
  const file = join(root, '.st-check.toml')
  if (!existsSync(file)) return []
  const deep = (parseToml(readFileSync(file, 'utf8')).deep ?? {}) as TomlTable
  return ((deep.stages as TomlTable[] | undefined) ?? []).map((raw) => {
    const argv = raw.argv
    if (typeof raw.id !== 'string' || !Array.isArray(argv) || !argv.length)
      throw new ConfigError('deep stages need an id and an argv')
    return {
      id: raw.id,
      argv: argv as string[],
      timeoutS: typeof raw.timeout_seconds === 'number' ? raw.timeout_seconds : 600,
    }
  })
}

/** A line that says what went wrong (a FAIL line, a compiler or runtime error). */
const PROBLEM = /^(FAIL\b|ERROR\b)|\berror\b|\b\w*Error\b/i

/** One deep stage, its output streamed to out. A timeout or a missing tool is a failure. */
export function runDeep(
  root: string,
  stage: DeepStage,
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
): Promise<DeepResult> {
  const started = performance.now()
  return new Promise((done) => {
    const [file, ...args] = stage.argv as [string, ...string[]]
    const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let last = ''
    let problem = ''
    let partial = ''
    const note = (line: string) => {
      if (!line.trim()) return
      last = line.trim()
      if (PROBLEM.test(last)) problem = last
    }
    const keep = (chunk: Buffer) => {
      const lines = (partial + chunk.toString('utf8')).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        out(`  ${stage.id}: ${line}`)
        note(line)
      }
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, stage.timeoutS * 1000)
    const finish = (passed: boolean, why: string) => {
      clearTimeout(timer)
      done({ id: stage.id, passed, ms: performance.now() - started, last: why })
    }
    child.on('error', (error) => finish(false, `could not start: ${error.message}`))
    child.on('close', (code) => {
      note(partial)
      if (timedOut) finish(false, `stopped after ${stage.timeoutS} s`)
      else finish(code === 0, (code === 0 ? last : problem || last) || `exit ${code}`)
    })
  })
}

const headSha = (root: string) => git(root, ['rev-parse', 'HEAD^{commit}']).trim()

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`

/** What a live stage passed without running: "passed" alone would hide a test with no model exercised. */
const skips = (deep: DeepResult[]) =>
  deep
    .flatMap((result) => {
      const said = result.last.match(/\((skipped[^)]*)\)/)?.[1]
      return said ? [`; ${result.id} ${said}`] : []
    })
    .join('')

/** The Status sentence: gate time (and last night's), slowest stages, live results, failures. */
export function summary(gate: GateResult, deep: DeepResult[], previousMs: number | null): string {
  const failedStages = gate.results.filter(
    (result) => result.required && result.state !== 'pass' && result.state !== 'skip',
  )
  const slowest = [...gate.results]
    .filter((result) => result.state !== 'skip')
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)
    .map((result) => `${result.id} ${seconds(result.ms)}`)
  const was = previousMs === null ? '' : ` (last night ${seconds(previousMs)})`
  const at = gate.sha ? ` at ${gate.sha.slice(0, 10)}` : ''
  const gateText = gate.refused
    ? `gate did not run: ${gate.refused}`
    : `gate ${gate.passed ? 'passed' : `failed (${failedStages.map((r) => r.id).join(', ')})`} in ${seconds(gate.ms)}${was}${at}; slowest ${slowest.join(', ')}`
  const deepFailed = deep.filter((result) => !result.passed)
  const deepText = !deep.length
    ? 'no live checks declared'
    : deepFailed.length
      ? `live failed: ${deepFailed.map((r) => `${r.id} (${r.last.slice(0, 80)})`).join('; ')}`
      : `live passed: ${deep.map((r) => r.id).join(', ')}${skips(deep)}`
  const ok = gate.passed && !gate.refused && !deepFailed.length
  return `Nightly checks ${ok ? 'passed' : 'failed'}: ${gateText}. ${deepText}.`
}

export interface NightlyOptions {
  config: Config
  coordination: Coordination
  env: NodeJS.ProcessEnv
  out: (line: string) => void
  /** Test seams: the gate and one deep stage. */
  gate?: () => Promise<GateResult>
  deep?: (stage: DeepStage) => Promise<DeepResult>
}

export async function nightly(options: NightlyOptions): Promise<{ ok: boolean; line: string }> {
  const { config, out, env } = options
  const root = config.root
  const gate: GateResult = await (
    options.gate ??
    (async () => {
      try {
        const report = await accept(config, {
          coordination: options.coordination,
          reuse: false,
          out,
          env,
        })
        return { passed: report.passed, ms: report.ms, sha: report.sha, results: report.results }
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error
        return { passed: false, ms: 0, results: [], refused: error.message }
      }
    })
  )()
  const runAll = async (work: string) => {
    const results: DeepResult[] = []
    for (const stage of deepStages(work)) {
      out(`NIGHTLY:${stage.id}`)
      const result = await (
        options.deep ?? ((s) => runDeep(work, s, { ...env, AICO_MAIN_CHECKOUT: root }, out))
      )(stage)
      out(`NIGHTLY:${result.passed ? 'PASS' : 'FAIL'}:${stage.id} ${seconds(result.ms)}`)
      results.push(result)
    }
    return results
  }
  const deep = options.deep
    ? await runAll(root)
    : await withWorktree(config, gate.sha ?? headSha(root), (work) => runAll(work))
  const store = receiptStore(root)
  const previous = store.get<{ gate_ms: number }>('nightly-last')
  const line = summary(gate, deep, previous?.gate_ms ?? null)
  if (!gate.refused && gate.ms > 0)
    store.put('nightly-last', { at: new Date().toISOString(), gate_ms: Math.round(gate.ms) })
  return { ok: gate.passed && !gate.refused && deep.every((result) => result.passed), line }
}

const USAGE = 'aico nightly [--source ID]: the full gate on HEAD, then the live checks'

export async function nightlyCli(argv: string[], env = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { source: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  })
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const db = openTasksDb(tasksDbPathFromEnv(env))
  let root: string | null
  try {
    const registry = new Registry(db)
    const project = values.source ? registry.get(values.source) : registry.forCwd(process.cwd())
    root = project?.root_path ?? null
  } finally {
    db.close()
  }
  if (!root || !existsSync(root)) {
    console.error(`aico nightly: no checkout for ${values.source ?? 'this directory'}`)
    return 2
  }
  const config = loadConfig(root)
  if ('unsupported' in config) {
    console.error(`aico nightly: ${config.unsupported}`)
    return 2
  }
  const { ok, line } = await nightly({
    config,
    coordination: hookCoordination(env),
    env,
    out: (text) => console.log(text),
  })
  console.log(line)
  return ok ? 0 : 1
}
