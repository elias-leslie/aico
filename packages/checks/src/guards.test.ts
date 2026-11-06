import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  countFindings,
  DEAD_CODE_BASELINE,
  deadCodeGuard,
  describeIssue,
  type Fallow,
  findSuppressions,
  goneFromBaseline,
  newFindings,
  SUPPRESSIONS_BASELINE,
  suppressionsGuard,
  unjustified,
} from './guards'

// The markers are assembled here so this file never trips the guard itself.
const ts = (rule: string) => `// @ts-${rule}`
const lint = `// eslint-${'disable'}-next-line`
const biome = `// biome-${'ignore'}`
const noqa = `# no${'qa'}`
const skip = (fn: string) => `${fn}.${'skip'}(`

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'aico-guards-'))
  roots.push(root)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  return root
}

describe('unjustified', () => {
  it.each([
    [`${ts('ignore')}`, 'ts-ignore'],
    [`${ts('expect-error')} -`, 'ts-ignore'],
    [`${lint} no-console`, 'eslint-disable'],
    [`${lint} react-hooks/exhaustive-deps no-console`, 'eslint-disable'],
    [`${biome} lint/suspicious/noExplicitAny:`, 'biome-ignore'],
    [`except Exception:  ${noqa}: BLE001`, 'noqa'],
    [`except Exception:  ${noqa}`, 'noqa'],
    [`x = y  # type: ${'ignore'}[attr-defined]`, 'type-ignore'],
    [`#[al${'low'}(clippy::too_many_arguments)]`, 'rust-allow'],
    [`@Sup${'press'}("DEPRECATION")`, 'kotlin-suppress'],
    [`${skip('it')}'does a thing', () => {`, 'skipped-test'],
    [`${skip('describe')}'suite', () => { // todo`, 'skipped-test'],
    [`@pytest.mark.${'skip'}`, 'skipped-test'],
  ])('flags %s', (line, marker) => {
    expect(unjustified(line)).toBe(marker)
  })

  it.each([
    `${ts('expect-error')} the upstream type misses this overload`,
    `${lint} no-console -- the test harness reads stdout`,
    `${biome} lint/suspicious/noControlCharactersInRegex: ANSI colour codes`,
    `/* ${'biome'}-ignore lint/a/b: generated table */`,
    `except Exception:  ${noqa}: BLE001 - a hook fails open and quiet`,
    `except Exception:  ${noqa}: BLE001 -- never print a secret`,
    `x = y  # type: ${'ignore'}[attr-defined]  # typer adds it at runtime`,
    `#[al${'low'}(dead_code)] // the texts show in Debug output`,
    `${skip('it')}'does a thing', () => { // flaky upstream timer, see notes`,
    `t.${'Skip'}("codex is required")`,
    'const plain = 1 // nothing suppressed here',
  ])('accepts %s', (line) => {
    expect(unjustified(line)).toBeNull()
  })
})

describe('suppressions baseline', () => {
  it('counts per file and line text, so a copy of a known line is new', () => {
    const line = `except Exception:  ${noqa}: BLE001`
    const root = tree({ 'a.py': `${line}\nok = 1\n`, 'b.py': `${line}\n`, 'notes.md': `${line}\n` })
    const all = findSuppressions(root, ['a.py', 'b.py', 'notes.md'])
    expect(all.map((f) => `${f.file}:${f.line}`)).toEqual(['a.py:1', 'b.py:1'])
    const baseline = countFindings(all.slice(0, 1))
    expect(baseline).toEqual({ 'a.py': { [line]: 1 } })
    expect(newFindings(all, baseline).map((f) => f.file)).toEqual(['b.py'])
    expect(goneFromBaseline([], baseline)).toBe(1)
  })

  it('fails on a new one, passes once it is in the baseline, and checks only the scope', () => {
    const root = tree({ 'src/a.ts': `${ts('ignore')}\nconst a = 1\n`, 'src/b.ts': 'b\n' })
    execFileSync('git', ['init', '-q'], { cwd: root })
    const lines: string[] = []
    const io = { root, scope: null, update: false, out: (line: string) => lines.push(line) }
    expect(suppressionsGuard({ ...io, scope: ['src/a.ts'] })).toBe(1)
    expect(lines[0]).toContain('src/a.ts:1: ts-ignore')
    expect(suppressionsGuard({ ...io, scope: ['src/b.ts'] })).toBe(0)
    expect(suppressionsGuard({ ...io, update: true })).toBe(0)
    expect(JSON.parse(readFileSync(join(root, SUPPRESSIONS_BASELINE), 'utf8'))).toEqual({
      'src/a.ts': { [ts('ignore')]: 1 },
    })
    expect(suppressionsGuard({ ...io, scope: ['src/a.ts'] })).toBe(0)
  })
})

describe('dead-code guard', () => {
  const report = {
    version: '2.57.0',
    summary: { total_issues: 3 },
    unused_files: ['src/old.ts'],
    unused_exports: [{ path: 'src/a.ts', name: 'helper', line: 4 }],
    circular_dependencies: [{ files: ['src/x.ts', 'src/y.ts'], line: 2 }],
  }
  const fake =
    (stdout: string, calls: string[][] = []): Fallow =>
    (args) => {
      calls.push(args)
      return { code: 1, stdout }
    }

  it('describes each issue kind on one line', () => {
    expect(describeIssue({ kind: 'unused_exports', item: report.unused_exports[0] })).toBe(
      'unused_exports: src/a.ts:4 helper',
    )
    expect(
      describeIssue({ kind: 'circular_dependencies', item: report.circular_dependencies[0] }),
    ).toBe('circular_dependencies: src/x.ts -> src/y.ts:2')
    expect(
      describeIssue({
        kind: 'unlisted_dependencies',
        item: { package_name: 'left-pad', imported_from: [{ path: 'src/a.ts', line: 1 }] },
      }),
    ).toBe('unlisted_dependencies: src/a.ts left-pad')
  })

  it('fails on findings beyond the baseline, only those in the scope when there is one', () => {
    const lines: string[] = []
    const calls: string[][] = []
    const io = { root: '/r', scope: null, update: false, out: (line: string) => lines.push(line) }
    expect(deadCodeGuard(io, fake(JSON.stringify(report), calls))).toBe(1)
    expect(calls[0]).toEqual(expect.arrayContaining(['--baseline', DEAD_CODE_BASELINE]))
    expect(lines.slice(0, 3)).toEqual([
      'unused_files: src/old.ts',
      'unused_exports: src/a.ts:4 helper',
      'circular_dependencies: src/x.ts -> src/y.ts:2',
    ])
    lines.length = 0
    expect(deadCodeGuard({ ...io, scope: ['src/y.ts'] }, fake(JSON.stringify(report)))).toBe(1)
    expect(lines[0]).toBe('circular_dependencies: src/x.ts -> src/y.ts:2')
    expect(deadCodeGuard({ ...io, scope: ['src/z.ts'] }, fake(JSON.stringify(report)))).toBe(0)
  })

  it('fails when fallow gives no report', () => {
    const lines: string[] = []
    const io = { root: '/r', scope: null, update: false, out: (line: string) => lines.push(line) }
    expect(deadCodeGuard(io, fake('boom'))).toBe(1)
    expect(lines[0]).toContain('no JSON report')
  })
})
