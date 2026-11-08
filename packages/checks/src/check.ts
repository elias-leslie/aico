// One check of a working tree: the scope (the caller's own changed files unless told otherwise),
// the optional formatter pass on that scope only, the planned stages, their run, a reusable pass
// receipt and the Status row.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { blobIds, changedFiles, git, gitOk } from './git'
import { type Coordination, CoordinationError, othersClaim } from './hook'
import { noteLocalCheck } from './local-check'
import { type Config, type Lane, type Planned, plan, toolBinary } from './plan'
import { roadmapStep } from './roadmap'
import { passed, receiptStore, resultLine, runSteps, type StepResult } from './run'
import type { CheckSummary } from './status'

export interface CheckOptions {
  lane: Lane
  /** Scope the full gate to changed files too (the quick lane always is). */
  changedOnly?: boolean
  /** Pathspecs: the scope is the changed files under them (commit, --paths). */
  paths?: string[]
  /** Apply Biome and ruff fixes to the scope first (never outside it). */
  fix?: boolean
  /** Reuse a pass of the same lane on identical content (default true). */
  reuse?: boolean
  jobs?: number
  out?: (line: string) => void
  coordination?: Coordination
  env?: NodeJS.ProcessEnv
}

export interface CheckReport extends CheckSummary {
  lane: Lane
  /** The changed files checked, or null for the whole tree. */
  scope: string[] | null
  reused?: boolean
}

/** Changed files no other agent wrote or leases: what this caller's check and formatter act on. */
export function ownChanged(
  root: string,
  coordination: Coordination | undefined,
  out: (line: string) => void = () => {},
  pathspecs: string[] = [],
): string[] {
  const changed = changedFiles(root, pathspecs)
  if (!coordination || !changed.length) return changed
  let foreign: Record<string, string[]>
  try {
    foreign = coordination.foreign(root, changed)
  } catch (error) {
    if (!(error instanceof CoordinationError)) throw error
    out(`CHECK:WARN:${error.message}; checking every changed file`)
    return changed
  }
  const others = changed.filter((file) => othersClaim(foreign[file]))
  if (others.length)
    out(`CHECK:SCOPE:left out ${others.length} changed file(s) other agents wrote or lease`)
  return changed.filter((file) => !othersClaim(foreign[file]))
}

function envFiles(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env.ST_CHECK_CHANGED_FILES?.trim()
  if (!raw) return null
  return [
    ...new Set(
      raw
        .split(/[\n:]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort()
}

/** What the check covers: the given files, the changed files under --paths, or the caller's own changes. */
export function checkScope(root: string, options: CheckOptions): string[] | null {
  const fromEnv = envFiles(options.env ?? process.env)
  if (fromEnv) return fromEnv
  if (options.paths?.length) return changedFiles(root, options.paths)
  if (options.lane === 'quick' || options.changedOnly || options.fix)
    return ownChanged(root, options.coordination, options.out)
  return null
}

/**
 * What --fix may rewrite. Known other writers always stay out. Unattributed writes need an
 * individually named file, because a directory or glob can sweep up another session's work.
 */
function fixable(
  root: string,
  scope: string[],
  options: CheckOptions,
  out: (line: string) => void,
): string[] {
  if (!options.coordination) return scope
  let foreign: Record<string, string[]>
  try {
    foreign = options.coordination.foreign(root, scope)
  } catch (error) {
    if (!(error instanceof CoordinationError)) throw error
    out(`CHECK:FIX:skipped: ${error.message}`)
    return []
  }
  const explicit = new Set(options.paths ?? envFiles(options.env ?? process.env) ?? [])
  const excluded = (file: string) =>
    othersClaim(foreign[file]) || (!!foreign[file]?.length && !explicit.has(file))
  const unsure = scope.filter(excluded)
  // Name only files a formatter would touch, and at most ten: images and notes are noise here.
  const named = unsure.filter((file) => [...BIOME_FIX, '.py'].includes(posix.extname(file)))
  if (unsure.length)
    out(
      `CHECK:FIX:left out ${unsure.length} file(s) another session wrote or whose writer is unknown (name your own unknown files individually with --paths)${named.length ? `: ${named.slice(0, 10).join(', ')}${named.length > 10 ? `, +${named.length - 10} more` : ''}` : ''}`,
    )
  return scope.filter((file) => !excluded(file))
}

const BIOME_FIX = [
  '.css',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]

/** Formatter fixes on exactly these files: Biome on web sources, ruff on Python. Returns the commands run. */
export function fixScope(
  config: Config,
  files: string[],
): { tool: string; files: string[]; argv: string[] }[] {
  const present = files.filter((file) => existsSync(join(config.root, file)))
  const commands: { tool: string; files: string[]; argv: string[] }[] = []
  const web = present.filter((file) => BIOME_FIX.includes(posix.extname(file)))
  const biome = toolBinary(config, 'biome', 'biome', '.')
  if (web.length && existsSync(biome))
    commands.push({
      tool: 'biome',
      files: web,
      argv: [
        biome,
        'check',
        '--write',
        '--no-errors-on-unmatched',
        '--files-ignore-unknown=true',
        ...web,
      ],
    })
  const python = present.filter((file) => posix.extname(file) === '.py')
  if (
    python.length &&
    (config.legacy.includes('ruff') ||
      config.stages.some((stage) => posix.basename(stage.argv[0]) === 'ruff'))
  )
    commands.push({
      tool: 'ruff',
      files: python,
      argv: [
        toolBinary(config, 'ruff', 'ruff', '.'),
        'check',
        '--fix',
        '--output-format=concise',
        ...python,
      ],
    })
  return commands
}

/** Lane, gate config, the planned commands, HEAD's tree and the scope's content. */
function reuseKey(
  root: string,
  config: Config,
  lane: Lane,
  scope: string[] | null,
  planned: Planned[],
): string {
  const hash = createHash('sha256').update(`${config.digest}\0${lane}\0`)
  hash.update(JSON.stringify(planned.map((p) => p.step?.argv ?? p.skip ?? p.id)))
  hash.update(
    gitOk(root, ['rev-parse', '-q', '--verify', 'HEAD'])
      ? git(root, ['rev-parse', 'HEAD^{tree}'])
      : '-',
  )
  // Native stages and related tests can read dependencies beyond the named paths.
  const files = [...new Set([...(scope ?? []), ...changedFiles(root)])].sort()
  hash.update(scope ? 'scope' : 'tree')
  hash.update(JSON.stringify(scope))
  for (const [file, id] of blobIds(root, files)) hash.update(`${file}\0${id}\n`)
  return `${lane}-${hash.digest('hex').slice(0, 32)}`
}

export async function runCheck(config: Config, options: CheckOptions): Promise<CheckReport> {
  const { root } = config
  // A working-tree check is evidence for HEAD only when it starts and finishes clean.
  const checkedSha =
    !changedFiles(root).length && gitOk(root, ['rev-parse', '--verify', 'HEAD'])
      ? git(root, ['rev-parse', 'HEAD']).trim()
      : null
  const record = (report: CheckReport) => {
    // An empty quick invocation checked no candidate. A commit's scoped quick
    // gate records its own proof after committing; a full clean-tree check can too.
    if (report.scope?.length === 0) return
    if (
      checkedSha &&
      !changedFiles(root).length &&
      git(root, ['rev-parse', 'HEAD']).trim() === checkedSha
    )
      noteLocalCheck(root, checkedSha, report, out)
  }
  const out = options.out ?? (() => {})
  const started = performance.now()
  const scope = checkScope(root, options)
  if (options.fix && scope?.length) {
    for (const { tool, files, argv } of fixScope(config, fixable(root, scope, options, out))) {
      const fixed = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8' })
      out(
        `CHECK:FIX:${tool}:${files.length} file(s)${fixed.status ? '; fixed what it could, the check below shows what is left' : ''}`,
      )
    }
  }
  const roadmap = roadmapStep(root, scope)
  if (roadmap) {
    out(resultLine(roadmap))
    out(`CHECK:FAIL ${options.lane}: roadmap`)
    return { lane: options.lane, passed: false, results: [roadmap], ms: 0, scope }
  }
  const store = receiptStore(root)
  const reuse = options.reuse !== false
  const planned = plan(config, options.lane, scope, () => trackedFiles(root))
  const key = reuse ? reuseKey(root, config, options.lane, scope, planned) : null
  const prior = key ? store.get<CheckReport & { at?: string }>(key) : null
  if (prior?.passed) {
    out(
      `CHECK:PASS ${options.lane} reused: the same content passed at ${prior.at ?? 'an earlier run'}`,
    )
    record(prior)
    return { ...prior, reused: true, ms: performance.now() - started }
  }
  out(`CHECK:${options.lane}:${scope ? `${scope.length} changed file(s)` : 'whole tree'}`)
  const results: StepResult[] = await runSteps(config, options.lane, planned, {
    jobs: options.jobs,
    out,
    reuse,
    env: options.env,
  })
  const report: CheckReport = {
    lane: options.lane,
    passed: passed(results),
    results,
    ms: performance.now() - started,
    scope,
  }
  const failed = results.filter(
    (result) => result.required && !['pass', 'skip'].includes(result.state),
  )
  const ran = results.filter((result) => result.state !== 'skip').length
  out(
    `CHECK:${report.passed ? 'PASS' : 'FAIL'} ${options.lane} ${(report.ms / 1000).toFixed(1)}s (${ran} ran, ${results.length - ran} skipped)${failed.length ? `: ${failed.map((r) => r.id).join(', ')}` : ''}`,
  )
  if (key && report.passed) store.put(key, { ...report, at: new Date().toISOString() })
  record(report)
  return report
}

/** Tracked and untracked, not ignored files (what a whole-tree scan reads). */
export function trackedFiles(root: string): string[] {
  return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean)
}
