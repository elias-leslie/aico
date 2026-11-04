import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accept } from './accept'
import { ownChanged, runCheck } from './check'
import { commit, refusals, selection, shortSubject } from './commit'
import type { Coordination } from './hook'
import { type Config, loadConfig, plan } from './plan'
import { judge, runSteps } from './run'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

function write(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}

/** A repo whose gate is declared stages run by node (no legacy tools). */
function repo(stages: string, extra = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'aico-checks-test-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'Test')
  write(
    root,
    '.st-check.toml',
    `[native]\nlegacy_tools = []\n${extra}\n[native.tools]\nnode = ${JSON.stringify(process.execPath)}\n\n${stages}`,
  )
  write(root, 'src/a.ts', 'a\n')
  write(root, 'src/b.ts', 'b\n')
  write(root, 'docs/readme.md', 'r\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

function config(root: string): Config {
  const loaded = loadConfig(root)
  if ('unsupported' in loaded) throw new Error(loaded.unsupported)
  return loaded
}

/** A stage that exits with code and appends a line to a log outside the repo. */
const stage = (id: string, fields: string, code = 0, log = '/dev/null') =>
  `[[native.stages]]\nid = "${id}"\nkind = "check"\ncoverage = "full"\n${fields}\nargv = ["node", "-e", ${JSON.stringify(`require('fs').appendFileSync(${JSON.stringify(log)}, '${id}\\n'); process.exit(${code})`)}]\n\n`

function coordination(foreign: Record<string, string[]> = {}, hold: string | null = null) {
  const committed: string[][] = []
  const fake: Coordination & { committed: Coordination['committed']; released: string[][] } = {
    foreign: (_root, paths) =>
      Object.fromEntries(paths.filter((p) => foreign[p]).map((p) => [p, foreign[p]])),
    guard: () => hold,
    committed: (_root, paths) => {
      committed.push(paths)
      return `Released ${paths.length} lease(s).`
    },
    released: committed,
  }
  return fake
}

describe('stage selection', () => {
  const stages = [
    stage('lint', 'quick = true\nquick_paths = ["src/**"]'),
    stage('suite', ''),
    stage('lint-src', 'quick = true\ncovered_by = "lint"'),
    stage('android', 'applicable = false\nreason = "no SDK here"'),
  ].join('')

  it('runs opted-in stages on matching changes in the quick lane, every uncovered stage in the full gate', () => {
    const cfg = config(repo(stages))
    const ids = (lane: 'quick' | 'full', changed: string[] | null) =>
      plan(cfg, lane, changed, () => []).map((p) => `${p.id}:${p.skip ?? 'run'}`)
    expect(ids('quick', ['src/a.ts'])).toEqual(['lint:run', 'lint-src:run', 'android:no SDK here'])
    expect(ids('quick', ['docs/readme.md'])).toEqual([
      'lint:no_relevant_changed_paths',
      'lint-src:run',
      'android:no SDK here',
    ])
    expect(ids('full', null)).toEqual(['lint:run', 'suite:run', 'android:no SDK here'])
  })

  it('leaves a repo without a [native] gate to st check', () => {
    const root = repo('')
    write(root, '.st-check.toml', '[paths]\nruff = ".venv/bin"\n')
    expect(loadConfig(root)).toEqual({
      unsupported: 'no [native] section (the legacy default gate)',
    })
  })
})

describe('the changed-only cone', () => {
  it('is the changed files no other agent wrote or leases', () => {
    const root = repo(stage('lint', 'quick = true'))
    write(root, 'src/a.ts', 'mine\n')
    write(root, 'src/b.ts', 'theirs\n')
    write(root, 'src/new.ts', 'unknown writer\n')
    write(root, 'docs/readme.md', 'leased by someone\n')
    const lines: string[] = []
    const own = ownChanged(
      root,
      coordination({
        'src/b.ts': ['cc:other'],
        'src/new.ts': ['unknown'],
        'docs/readme.md': ['lease:codex:1'],
      }),
      (line) => lines.push(line),
    )
    expect(own).toEqual(['src/a.ts', 'src/new.ts'])
    expect(lines).toEqual(['CHECK:SCOPE:left out 2 changed file(s) other agents wrote or lease'])
  })
})

describe('the overlap rule', () => {
  it('refuses a named agent’s file, and an unnamed writer’s only when swept in', () => {
    const foreign = {
      'a.ts': ['unknown'],
      'b.ts': ['cc:other'],
      'c.ts': ['unknown'],
      'd.ts': ['lease:cc:x'],
    }
    const swept = new Set(['c.ts', 'd.ts'])
    expect(refusals(['a.ts', 'b.ts', 'c.ts', 'd.ts'], swept, foreign)).toEqual([
      'b.ts (written by cc:other)',
      'c.ts (written by another session; name it explicitly to take it)',
    ])
  })

  it('names what a directory sweeps in', () => {
    const root = repo('')
    write(root, 'src/a.ts', 'x\n')
    write(root, 'src/b.ts', 'y\n')
    const picked = selection(root, ['src/a.ts', 'src'])
    expect(picked.files).toEqual(['src/a.ts', 'src/b.ts'])
    expect([...picked.swept]).toEqual(['src/b.ts'])
  })
})

describe('the formatter scope', () => {
  it('fixes only the caller’s own changed files', async () => {
    const root = repo('')
    // A stand-in Biome that stamps every file it is given.
    write(
      root,
      'node_modules/.bin/biome',
      `#!/usr/bin/env node\nconst fs=require('fs');for(const f of process.argv.slice(2).filter(a=>!a.startsWith('-')&&a!=='check'))fs.appendFileSync(f,'// formatted\\n')\n`,
    )
    chmodSync(join(root, 'node_modules/.bin/biome'), 0o755)
    write(root, '.gitignore', 'node_modules/\n')
    write(root, 'src/a.ts', 'mine\n')
    write(root, 'src/b.ts', 'theirs\n')
    await runCheck(config(root), {
      lane: 'quick',
      fix: true,
      coordination: coordination({ 'src/b.ts': ['cc:other'] }),
      env: {},
    })
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('mine\n// formatted\n')
    expect(readFileSync(join(root, 'src/b.ts'), 'utf8')).toBe('theirs\n')
  })
})

describe('commit', () => {
  it('commits only the named paths, leaves other edits and the index alone, and releases those leases', async () => {
    const root = repo(stage('lint', 'quick = true'))
    write(root, 'src/a.ts', 'a2\n')
    write(root, 'src/b.ts', 'b2\n')
    write(root, 'docs/readme.md', 'staged by someone else\n')
    git(root, 'add', 'docs/readme.md')
    const coord = coordination()
    const lines: string[] = []
    const result = await commit(config(root), {
      message: 'Change a',
      paths: ['src/a.ts'],
      coordination: coord,
      out: (line) => lines.push(line),
      env: {},
    })
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/a.ts')
    expect(git(root, 'status', '--porcelain', '--', 'src', 'docs')).toBe(
      'M  docs/readme.md\n M src/b.ts',
    )
    expect(result.tree).toBe(git(root, 'rev-parse', 'HEAD^{tree}'))
    expect(result.check?.passed).toBe(true)
    expect(coord.released).toEqual([['src/a.ts']])
    expect(lines).toContain(`COMMIT[1]:status=SUCCESS pushed=false detail=${result.sha}`)
  })

  it('refuses when the quick check fails, another agent wrote the file, or a hold stands', async () => {
    const failing = repo(stage('lint', 'quick = true', 1))
    write(failing, 'src/a.ts', 'a2\n')
    await expect(
      commit(config(failing), {
        message: 'x',
        paths: ['src/a.ts'],
        coordination: coordination(),
        env: {},
      }),
    ).rejects.toThrow('the quick check failed')

    const root = repo(stage('lint', 'quick = true'))
    write(root, 'src/a.ts', 'a2\n')
    await expect(
      commit(config(root), {
        message: 'x',
        paths: ['src/a.ts'],
        coordination: coordination({ 'src/a.ts': ['cc:other'] }),
      }),
    ).rejects.toThrow('src/a.ts (written by cc:other)')
    await expect(
      commit(config(root), {
        message: 'x',
        paths: ['src/a.ts'],
        coordination: coordination({}, 'aico: hold integration by codex:1; commit refused'),
      }),
    ).rejects.toThrow('hold integration')
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
  })

  it('moves a long first line into the body', () => {
    const long = `${'word '.repeat(30)}end`
    const [subject, blank, rest] = shortSubject(long).split('\n')
    expect(subject.length).toBeLessThanOrEqual(100)
    expect(blank).toBe('')
    expect(`${subject} ${rest}`).toBe(long)
  })
})

describe('receipts', () => {
  it('accepts a tree once, in a worktree of the commit, and keeps no receipt for a failure', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'aico-checks-log-')), 'runs')
    roots.push(dirname(log))
    const root = repo(stage('suite', '', 0, log))
    write(root, 'src/a.ts', 'uncommitted edits do not count\n')
    const first = await accept(config(root), { coordination: coordination() })
    expect(first.passed).toBe(true)
    expect(first.tree).toBe(git(root, 'rev-parse', 'HEAD^{tree}'))
    const second = await accept(config(root), { coordination: coordination() })
    expect(second.reused).toBe(true)
    expect(readFileSync(log, 'utf8')).toBe('suite\n')
    expect(git(root, 'worktree', 'list').split('\n')).toHaveLength(1)

    const failing = repo(stage('suite', '', 1, log))
    expect((await accept(config(failing), { coordination: coordination() })).passed).toBe(false)
    expect((await accept(config(failing), { coordination: coordination() })).reused).toBeUndefined()
  })

  it('reuses a full-gate stage’s pass while its declared inputs are unchanged', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'aico-checks-log-')), 'runs')
    roots.push(dirname(log))
    const root = repo(stage('native', 'inputs = ["src"]', 0, log))
    const cfg = config(root)
    const run = () =>
      runSteps(
        cfg,
        'full',
        plan(cfg, 'full', null, () => []),
      )
    expect((await run())[0].reused).toBeUndefined()
    write(root, 'docs/readme.md', 'not an input\n')
    expect((await run())[0].reused).toBe(true)
    write(root, 'src/a.ts', 'an input\n')
    expect((await run())[0].reused).toBeUndefined()
    expect(readFileSync(log, 'utf8')).toBe('native\nnative\n')
  })
})

describe('stage evidence', () => {
  const text = {
    format: 'text',
    source: 'combined',
    success_pattern: '^ok$',
    executed_pattern: '^PASS ',
    failure_pattern: '^FAIL ',
  } as const
  it('fails on recorded failures and calls a test stage that ran nothing unavailable', () => {
    expect(judge('test', text, 'PASS a\nPASS b\nok\n')).toEqual({ state: 'pass' })
    expect(judge('test', text, 'PASS a\nFAIL b\nok\n').reason).toBe('evidence_records_failures')
    expect(judge('test', text, 'ok\n')).toEqual({
      state: 'unavailable',
      reason: 'empty_or_skipped_required_tests',
    })
    expect(judge('check', text, 'nothing\n').reason).toBe('text evidence lacks its success marker')
    const junit = { format: 'junit', source: 'file', path: 'r.xml' } as const
    expect(
      judge(
        'test',
        junit,
        '<testsuite><testcase name="a"/><testcase name="b"><skipped/></testcase></testsuite>',
      ),
    ).toEqual({
      state: 'unavailable',
      reason: 'empty_or_skipped_required_tests',
    })
    expect(judge('test', junit, '<testcase name="a"/><testcase name="b"></testcase>')).toEqual({
      state: 'pass',
    })
  })
})
