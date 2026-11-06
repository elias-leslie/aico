// The two debt guards the gate runs (.st-check.toml stages `suppressions` and `dead-code`):
//
//   node packages/checks/src/guards.ts suppressions [--update]
//   node packages/checks/src/guards.ts dead-code [--update]
//
// suppressions: a lint/type suppression or a skipped test fails unless the same line says why
// (a few words after the marker, e.g. `-- reason`, or a biome-ignore's `: reason`). The ones
// already in the repo are in .suppressions-baseline.json (file -> line text -> count).
// dead-code: Fallow's dead-code findings that are not in .fallow-baseline.json.
// With CHECK_SCOPE_FILE (the quick lane's changed files, one per line) only findings in those
// files count; without it the whole tree does. --update rewrites the baseline from the tree.
// Self-contained (node: imports only) so Node runs this file directly, without a build.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SUPPRESSIONS_BASELINE = '.suppressions-baseline.json'
export const DEAD_CODE_BASELINE = '.fallow-baseline.json'

const CODE = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.kt',
  '.kts',
  '.sh',
])

interface Marker {
  name: string
  re: RegExp
  /** The rule codes right after the marker, which are not a reason. */
  codes?: RegExp
  /** Only a trailing comment counts as the reason (a skipped test's own text is its name). */
  commentOnly?: boolean
  /** Only text after a ` -- ` (or ` - `, ` — `) counts as the reason: rule names look like words. */
  afterDashes?: boolean
}

const MARKERS: Marker[] = [
  {
    name: 'biome-ignore',
    re: /(?:\/\/|\/\*)\s*biome-ignore(?:-all|-start|-end)?\b/,
    codes: /^\s*[\w/.()-]*\s*:?/,
  },
  {
    name: 'eslint-disable',
    re: /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b/,
    afterDashes: true,
  },
  { name: 'ts-ignore', re: /(?:\/\/|\/\*)\s*@ts-(?:ignore|expect-error|nocheck)\b/ },
  {
    name: 'fallow-ignore',
    re: /(?:\/\/|\/\*)\s*fallow-ignore(?:-next-line|-file)?\b/,
    afterDashes: true,
  },
  { name: 'nolint', re: /\/\/\s*nolint\b/, codes: /^(?::[\w,-]+)?/ },
  { name: 'noqa', re: /#\s*noqa\b/i, codes: /^(?::?\s*[A-Z]+\d+(?:\s*,\s*[A-Z]+\d+)*)?/ },
  { name: 'type-ignore', re: /#\s*(?:type|ty|pyright):\s*ignore\b/, codes: /^(?:\[[^\]]*\])?/ },
  { name: 'rust-allow', re: /#!?\[allow\(/, codes: /^[^\]]*\]/ },
  { name: 'kotlin-suppress', re: /@Suppress\(/, codes: /^[^)]*\)/ },
  { name: 'skipped-test', re: /\b(?:it|test|describe)\.(?:skip|only)\(/, commentOnly: true },
  { name: 'skipped-test', re: /@pytest\.mark\.skip\b(?!if)/ },
  { name: 'skipped-test', re: /\bt\.Skip(?:Now|f)?\(/ },
]

/** At least two words: a reason, not a bare rule code. */
const reasoned = (text: string) => (text.match(/[A-Za-z]{2,}/g) ?? []).length >= 2

/** The unjustified suppression on this line (its marker name), or null. */
export function unjustified(line: string): string | null {
  for (const marker of MARKERS) {
    const hit = marker.re.exec(line)
    if (!hit) continue
    let rest = line.slice(hit.index + hit[0].length)
    if (marker.codes) rest = rest.replace(marker.codes, '')
    if (marker.afterDashes) rest = /\s(?:--|-|—)\s(.*)$/.exec(rest)?.[1] ?? ''
    if (marker.commentOnly) rest = /(?:\/\/|#)(.*)$/.exec(rest)?.[1] ?? ''
    return reasoned(rest.replace(/\*\/\s*$/, '')) ? null : marker.name
  }
  return null
}

export type Counts = Record<string, Record<string, number>>
export interface Finding {
  file: string
  line: number
  text: string
  marker: string
}

/** Every unjustified suppression in these files. */
export function findSuppressions(root: string, files: readonly string[]): Finding[] {
  const found: Finding[] = []
  for (const file of files) {
    if (!CODE.has(extname(file)) || !existsSync(join(root, file))) continue
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    text.split('\n').forEach((line, index) => {
      const marker = unjustified(line)
      if (marker) found.push({ file, line: index + 1, text: line.trim(), marker })
    })
  }
  return found
}

export function countFindings(findings: readonly Finding[]): Counts {
  const counts: Counts = {}
  for (const { file, text } of [...findings].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    counts[file] ??= {}
    counts[file][text] = (counts[file][text] ?? 0) + 1
  }
  return counts
}

/** The findings beyond the baseline's count for the same file and line text. */
export function newFindings(findings: readonly Finding[], baseline: Counts): Finding[] {
  const left: Counts = JSON.parse(JSON.stringify(baseline))
  return findings.filter((finding) => {
    const known = left[finding.file]?.[finding.text] ?? 0
    if (known <= 0) return true
    left[finding.file][finding.text] = known - 1
    return false
  })
}

/** Baseline entries the files checked no longer have (whole-tree runs only). */
export function goneFromBaseline(findings: readonly Finding[], baseline: Counts): number {
  const now = countFindings(findings)
  let gone = 0
  for (const [file, lines] of Object.entries(baseline))
    for (const [text, count] of Object.entries(lines))
      gone += Math.max(0, count - (now[file]?.[text] ?? 0))
  return gone
}

const readJson = <T>(path: string, fallback: T): T =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback

/** Tracked and untracked, not ignored files. */
export function treeFiles(root: string): string[] {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`)
  return listed.stdout.split('\0').filter(Boolean)
}

/** The quick lane's changed files, or null for the whole tree. */
export function scopeFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const file = env.CHECK_SCOPE_FILE
  if (!file) return null
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
}

interface GuardIo {
  root: string
  scope: string[] | null
  update: boolean
  out: (line: string) => void
}

export function suppressionsGuard(io: GuardIo): number {
  const path = join(io.root, SUPPRESSIONS_BASELINE)
  const findings = findSuppressions(io.root, io.scope ?? treeFiles(io.root))
  if (io.update) {
    writeFileSync(path, `${JSON.stringify(countFindings(findings), null, 2)}\n`)
    io.out(`Suppressions baseline: ${findings.length} unjustified line(s) recorded.`)
    return 0
  }
  const baseline = readJson<Counts>(path, {})
  const fresh = newFindings(findings, baseline)
  for (const f of fresh)
    io.out(`${f.file}:${f.line}: ${f.marker} without a reason on the line: ${f.text.slice(0, 160)}`)
  if (fresh.length) {
    io.out(
      `${fresh.length} new suppression(s) or skipped test(s). Say why on the same line (e.g. "-- the reason"), or remove it.`,
    )
    return 1
  }
  const gone = io.scope ? 0 : goneFromBaseline(findings, baseline)
  io.out(
    `No new suppressions (${findings.length} known${gone ? `; ${gone} baseline line(s) gone: tighten with --update` : ''}).`,
  )
  return 0
}

const META = new Set([
  'schema_version',
  'version',
  'elapsed_ms',
  'total_issues',
  'entry_points',
  'summary',
  'workspace_diagnostics',
  'next_steps',
])

export interface DeadIssue {
  kind: string
  item: unknown
}

/** Fallow's JSON report as one list of issues. */
export function deadIssues(report: Record<string, unknown>): DeadIssue[] {
  const issues: DeadIssue[] = []
  for (const [kind, value] of Object.entries(report))
    if (!META.has(kind) && Array.isArray(value))
      for (const item of value) issues.push({ kind, item })
  return issues
}

/** One line naming the issue's file(s) and symbol. */
export function describeIssue({ kind, item }: DeadIssue): string {
  if (typeof item === 'string') return `${kind}: ${item}`
  const value = item as Record<string, unknown>
  const where =
    (value.path as string | undefined) ??
    (value.files as string[] | undefined)?.join(' -> ') ??
    (value.locations as { path: string }[] | undefined)?.map((l) => l.path).join(', ') ??
    (value.imported_from as { path: string }[] | undefined)?.map((l) => l.path).join(', ') ??
    ''
  const line = typeof value.line === 'number' ? `:${value.line}` : ''
  const name = [
    value.parent_name,
    value.member_name ?? value.name ?? value.export_name ?? value.package_name,
  ]
    .filter((part) => typeof part === 'string')
    .join('.')
  return `${kind}: ${where}${line}${name ? ` ${name}` : ''}`
}

export const inScope = (issue: DeadIssue, scope: readonly string[]) => {
  const text = JSON.stringify(issue.item)
  return scope.some((file) => text.includes(JSON.stringify(file).slice(1, -1)))
}

export type Fallow = (args: string[], root: string) => { code: number | null; stdout: string }

const fallow: Fallow = (args, root) => {
  const run = spawnSync('fallow', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (run.error) throw new Error(`fallow did not start: ${run.error.message}`)
  return { code: run.status, stdout: run.stdout }
}

export function deadCodeGuard(io: GuardIo, run: Fallow = fallow): number {
  const base = ['dead-code', '--quiet', '--no-cache']
  if (io.update) {
    run([...base, '--save-baseline', DEAD_CODE_BASELINE], io.root)
    io.out(`Dead-code baseline saved to ${DEAD_CODE_BASELINE}.`)
    return 0
  }
  const { stdout } = run([...base, '--format', 'json', '--baseline', DEAD_CODE_BASELINE], io.root)
  let report: Record<string, unknown>
  try {
    report = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    io.out(`fallow gave no JSON report: ${stdout.trim().slice(0, 200)}`)
    return 1
  }
  const scope = io.scope
  const fresh = deadIssues(report).filter((issue) => !scope || inScope(issue, scope))
  for (const issue of fresh) io.out(describeIssue(issue))
  if (fresh.length) {
    io.out(
      `${fresh.length} new dead-code finding(s). Remove the code, or use it; a real entry point goes in .fallowrc.json.`,
    )
    return 1
  }
  io.out('No new dead code.')
  return 0
}

export function main(argv: string[], env = process.env, root = process.cwd()): number {
  const [guard, ...flags] = argv
  const unknown = flags.filter((flag) => flag !== '--update')
  if ((guard !== 'suppressions' && guard !== 'dead-code') || unknown.length) {
    console.error('Usage: guards.ts suppressions|dead-code [--update]')
    return 2
  }
  const io: GuardIo = {
    root,
    scope: scopeFromEnv(env),
    update: flags.includes('--update'),
    out: (line) => console.log(line),
  }
  return guard === 'suppressions' ? suppressionsGuard(io) : deadCodeGuard(io)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exit(main(process.argv.slice(2)))
