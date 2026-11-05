import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openTasksDb, Registry, runTasks, TaskStore } from '@aico/tasks'
import { afterEach, describe, expect, it } from 'vitest'
import { accept } from './accept'
import { ownChanged, runCheck } from './check'
import { runCli } from './cli'
import { commit, refusals, selection, shortSubject } from './commit'
import { doneWithReceipt } from './done'
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
  write(root, '.gitignore', '.dev-tools/\n')
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

  it('retains the standard gate for a repo without a native declaration', () => {
    const root = repo('')
    write(root, '.st-check.toml', '[paths]\nruff = ".venv/bin"\n')
    expect(config(root)).toMatchObject({
      legacyDefault: true,
      legacy: ['ruff', 'types', 'pytest', 'biome', 'tsc', 'vitest', 'security'],
    })
  })

  it('limits declared Biome stages to selected files in both lanes', () => {
    const root = repo('')
    write(
      root,
      '.st-check.toml',
      `[native]\nlegacy_tools = []\n[[native.stages]]\nid = "biome"\nkind = "check"\ncoverage = "full"\nquick = true\nargv = ["node_modules/.bin/biome", "check", "."]\n`,
    )
    for (const lane of ['quick', 'full'] as const) {
      const steps = plan(config(root), lane, ['src/a.ts'], () => [])
      expect(steps.find((item) => item.id === 'biome')?.step?.argv.slice(2)).toContain('src/a.ts')
      expect(steps.find((item) => item.id === 'biome')?.step?.argv).not.toContain('.')
    }
  })
})

describe('focused pytest', () => {
  it('runs the tests that import a changed module, and pytest in the quick lane only when installed', () => {
    const root = repo('')
    write(root, 'backend/app/pricing.py', 'x = 1\n')
    write(root, 'backend/tests/test_imports.py', 'from app.pricing import x\n')
    write(root, 'backend/tests/test_from_parent.py', 'from app import (\n  pricing,\n)\n')
    write(root, 'backend/tests/test_mentions.py', '# pricing is only a word here\n')
    const steps = () =>
      plan(config(root), 'quick', ['backend/app/pricing.py'], () => []).map(
        (p) => p.step?.argv.slice(1).join(' ') ?? `${p.id}:${p.skip}`,
      )
    expect(steps()).toEqual([])
    write(root, 'backend/.venv/bin/pytest', '')
    expect(steps()).toEqual([
      '-q --tb=short --no-cov tests/test_from_parent.py tests/test_imports.py',
    ])
    expect(plan(config(root), 'full', null, () => []).map((p) => p.id)).toEqual([])
  })
})

describe('vitest in a read-only checkout', () => {
  it('loads the config through the module runner without the cache when Vitest offers both', () => {
    const root = repo('')
    write(root, '.st-check.toml', `[native]\nlegacy_tools = ["vitest"]\n`)
    write(root, 'node_modules/.bin/vitest', '')
    write(root, 'src/c.test.ts', 'c\n')
    const argv = () =>
      plan(config(root), 'quick', ['src/c.test.ts'], () => [])[0]
        .step?.argv.slice(1)
        .join(' ')
    expect(argv()).toBe('related --run src/c.test.ts')
    write(
      root,
      'node_modules/vitest/dist/chunks/cac.x.js',
      'configLoader: { description: "runner" }, cache: { description: "Enable cache" }',
    )
    expect(argv()).toBe('related --run --configLoader runner --cache=false src/c.test.ts')
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
    write(root, 'src/c.ts', 'unattributed\n')
    const lines: string[] = []
    await runCheck(config(root), {
      lane: 'quick',
      fix: true,
      coordination: coordination({ 'src/b.ts': ['cc:other'], 'src/c.ts': ['unknown'] }),
      env: {},
      out: (line) => lines.push(line),
    })
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('mine\n// formatted\n')
    expect(readFileSync(join(root, 'src/b.ts'), 'utf8')).toBe('theirs\n')
    // A write the store could not attribute is checked but never rewritten, unless named.
    expect(readFileSync(join(root, 'src/c.ts'), 'utf8')).toBe('unattributed\n')
    expect(lines.join('\n')).toContain('CHECK:FIX:left out 1 file(s)')
    await runCheck(config(root), {
      lane: 'quick',
      fix: true,
      paths: ['src/c.ts'],
      coordination: coordination({ 'src/c.ts': ['unknown'] }),
      env: {},
    })
    expect(readFileSync(join(root, 'src/c.ts'), 'utf8')).toBe('unattributed\n// formatted\n')
  })

  it('does not let a directory or environment override rewrite another session’s files', async () => {
    const root = repo('')
    write(
      root,
      'node_modules/.bin/biome',
      `#!/usr/bin/env node\nconst fs=require('fs');for(const f of process.argv.slice(2).filter(a=>!a.startsWith('-')&&a!=='check'))fs.appendFileSync(f,'// formatted\\n')\n`,
    )
    chmodSync(join(root, 'node_modules/.bin/biome'), 0o755)
    write(root, '.gitignore', 'node_modules/\n.dev-tools/\n')
    const coord = coordination({ 'src/b.ts': ['cc:other'], 'src/c.ts': ['unknown'] })
    for (const options of [
      { paths: ['src'], env: {} },
      { env: { ST_CHECK_CHANGED_FILES: 'src/a.ts:src/b.ts' } },
    ]) {
      write(root, 'src/a.ts', 'mine\n')
      write(root, 'src/b.ts', 'theirs\n')
      write(root, 'src/c.ts', 'uncertain\n')
      await runCheck(config(root), { lane: 'quick', fix: true, coordination: coord, ...options })
      expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('mine\n// formatted\n')
      expect(readFileSync(join(root, 'src/b.ts'), 'utf8')).toBe('theirs\n')
      expect(readFileSync(join(root, 'src/c.ts'), 'utf8')).toBe('uncertain\n')
    }
  })
})

describe('commit', () => {
  it('does not invalidate declared inputs for an unrelated gate-file comment', async () => {
    const root = repo(
      `[[native.stages]]\nid = "selected"\nkind = "check"\ncoverage = "full"\nquick = true\ninputs = ["src"]\nargv = ["node", "-e", ${JSON.stringify("require('fs').appendFileSync('.st-check.toml','\\n# another lane documents its gate\\n')")}]\n`,
    )
    write(root, 'src/a.ts', 'a2\n')
    await expect(
      commit(config(root), {
        message: 'Selected source',
        paths: ['src/a.ts'],
        coordination: coordination(),
        env: {},
      }),
    ).resolves.toMatchObject({ files: ['src/a.ts'] })
  })

  it('does not treat stage selection patterns as declared inputs', async () => {
    const root = repo(
      `[[native.stages]]\nid = "selected"\nkind = "check"\ncoverage = "full"\nquick = true\nquick_paths = ["src/**", "native/**"]\nargv = ["node", "-e", ${JSON.stringify("require('fs').mkdirSync('native',{recursive:true}); require('fs').writeFileSync('native/other.py','other lane')")}]\n`,
    )
    write(root, 'src/a.ts', 'a2\n')
    await expect(
      commit(config(root), {
        message: 'Selected source',
        paths: ['src/a.ts'],
        coordination: coordination(),
        env: {},
      }),
    ).resolves.toMatchObject({ files: ['src/a.ts'] })
  })

  it('refuses changed stage inputs without treating an unrelated file as an input', async () => {
    const root = repo('')
    write(
      root,
      '.st-check.toml',
      `[native]\nlegacy_tools = []\n[native.tools]\nnode = ${JSON.stringify(process.execPath)}\n[[native.stages]]\nid = "read-input"\nkind = "check"\ncoverage = "full"\nquick = true\ninputs = ["src"]\nargv = ["node", "-e", ${JSON.stringify("const fs = require('fs'); fs.readFileSync('src/b.ts'); fs.writeFileSync('.dev-tools/read-ready', 'ready'); const timer=setInterval(()=>{ if(fs.existsSync('.dev-tools/read-release')) { clearInterval(timer); process.exit(0) } },10)")}]\n`,
    )
    git(root, 'add', '.st-check.toml')
    git(root, 'commit', '-qm', 'Gate')
    write(root, 'src/a.ts', 'a2\n')
    const pending = commit(config(root), {
      message: 'First lane',
      paths: ['src/a.ts'],
      coordination: coordination(),
      env: {},
    })
    while (!existsSync(join(root, '.dev-tools/read-ready')))
      await new Promise((resolve) => setTimeout(resolve, 10))
    write(root, 'src/b.ts', 'changed dependency\n')
    write(root, '.dev-tools/read-release', 'go')
    await expect(pending).rejects.toThrow(/quick check failed/)
    expect(git(root, 'log', '-1', '--format=%s')).toBe('Gate')
  })

  it('lets another lane edit and commit unrelated paths while a selected-path stage runs', async () => {
    const root = repo(stage('lint', 'quick = true\nquick_paths = ["src/**"]\ninputs = ["src"]'))
    write(root, 'src/a.ts', 'a2\n')
    write(root, 'docs/readme.md', 'other lane\n')
    const first = commit(config(root), {
      message: 'First lane',
      paths: ['src/a.ts'],
      coordination: coordination(),
      env: {},
    })
    const second = commit(config(root), {
      message: 'Second lane',
      paths: ['docs/readme.md'],
      coordination: coordination(),
      env: {},
    })
    const results = await Promise.all([first, second])
    expect(results.map((r) => r.files)).toEqual([['src/a.ts'], ['docs/readme.md']])
    expect(git(root, 'status', '--porcelain')).toBe('')
    expect(git(root, 'log', '-2', '--format=%s').split('\n').sort()).toEqual([
      'First lane',
      'Second lane',
    ])
  })

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

  it('keeps a long subject and its trailers whole', () => {
    const long = `${'word '.repeat(30)}end`
    expect(shortSubject(`${long}\n\nCo-Authored-By: Test <test@example.invalid>`)).toBe(
      `${long}\n\nCo-Authored-By: Test <test@example.invalid>`,
    )
  })

  it('refuses source changed while waiting for the commit lock', async () => {
    const root = repo('')
    write(root, 'src/a.ts', 'checked\n')
    const lock = join(root, '.git/aico-checks/commit.lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'pid'), String(process.pid))
    const pending = commit(config(root), {
      message: 'checked',
      paths: ['src/a.ts'],
      noCheck: true,
      coordination: coordination(),
    })
    write(root, 'src/a.ts', 'never checked\n')
    rmSync(lock, { recursive: true })
    await expect(pending).rejects.toThrow('source changed')
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
  })

  it('keeps spaces in an explicitly named CLI path', async () => {
    const root = repo('')
    write(root, 'src/with space.ts', 'new\n')
    const lines: string[] = []
    expect(
      await runCli('commit', ['-m', 'Add file', '--paths', 'src/with space.ts'], {
        cwd: root,
        env: {},
        coordination: coordination(),
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
      }),
    ).toBe(0)
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/with space.ts')
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

  it('closes a task with its paths committed and the tree receipt logged; a failing acceptance keeps it open', async () => {
    const run = async (code: number, edit: string) => {
      const root = repo(stage('suite', '', code))
      const db = openTasksDb(':memory:')
      new Registry(db).register({ id: 'p', root, name: 'P' })
      const store = new TaskStore(db)
      const env = { AICO_SESSION_ID: 'one' }
      const quiet = { out: () => {}, err: () => {} }
      await runTasks(['create', 'Edit a'], { db, cwd: root, env }, quiet)
      const task = { id: (db.prepare('SELECT id FROM tasks').get() as { id: string }).id }
      await runTasks(['claim', task.id], { db, cwd: root, env }, quiet)
      write(root, 'src/a.ts', edit)
      write(root, 'src/b.ts', 'someone else\n')
      const out: string[] = []
      const err: string[] = []
      const exit = await doneWithReceipt(
        [task.id, '-m', 'done', '--paths', 'src/a.ts'],
        { db, cwd: root, env, coordination: coordination() },
        { out: (l) => out.push(l), err: (l) => err.push(l) },
      )
      return { root, exit, out, err, task: store.get(task.id), log: store.log(task.id) }
    }
    const ok = await run(0, 'a2\n')
    expect(ok.exit).toBe(0)
    expect(git(ok.root, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/a.ts')
    expect(git(ok.root, 'status', '--porcelain', '--', 'src')).toBe('M src/b.ts')
    expect(ok.task?.status).toBe('completed')
    const tree = git(ok.root, 'rev-parse', 'HEAD^{tree}')
    expect(ok.log.at(-1)?.message).toMatch(
      new RegExp(`^receipt: tree ${tree} commit [0-9a-f]{40} check acceptance PASS`),
    )
    const failed = await run(1, 'a3\n')
    expect(failed.exit).toBe(1)
    expect(failed.err.join('\n')).toContain('acceptance failed')
    expect(failed.task?.status).not.toBe('completed')
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

  it('invalidates a scoped pass when another file read by a native stage changes', async () => {
    const root = repo(stage('lint', 'quick = true'))
    write(root, 'src/a.ts', 'selected\n')
    const run = () => runCheck(config(root), { lane: 'quick', paths: ['src/a.ts'], env: {} })
    expect((await run()).reused).toBeUndefined()
    expect((await run()).reused).toBe(true)
    write(root, 'src/b.ts', 'a changed dependency\n')
    expect((await run()).reused).toBeUndefined()
  })

  it('does not reuse a scoped native stage pass for a different file selection', async () => {
    const root = repo('')
    write(
      root,
      '.st-check.toml',
      `[native]\nlegacy_tools = []\n[native.tools]\nnode = ${JSON.stringify(process.execPath)}\n[[native.stages]]\nid = "biome"\nkind = "check"\ncoverage = "full"\ninputs = ["src"]\nargv = ["node_modules/.bin/biome", "check", "."]\n`,
    )
    write(root, '.gitignore', '.dev-tools/\nnode_modules/\n')
    write(
      root,
      'node_modules/.bin/biome',
      '#!/usr/bin/env node\nprocess.exit(process.argv.includes("src/b.ts") ? 1 : 0)\n',
    )
    chmodSync(join(root, 'node_modules/.bin/biome'), 0o755)
    const cfg = config(root)
    const run = (file: string) =>
      runSteps(
        cfg,
        'full',
        plan(cfg, 'full', [file], () => []),
      )
    expect((await run('src/a.ts'))[0].state).toBe('pass')
    expect((await run('src/b.ts'))[0].state).toBe('fail')
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
    expect(
      judge(
        'test',
        junit,
        '<testsuite><testcase name="a"/><testcase name="b"></testcase></testsuite>',
      ),
    ).toEqual({
      state: 'pass',
    })
  })

  it('reads XML elements rather than markup in attributes, comments or CDATA', () => {
    const junit = { format: 'junit', source: 'stdout' } as const
    expect(
      judge('test', junit, '<testsuite><!-- <testcase name="fake"/> --></testsuite>').state,
    ).toBe('unavailable')
    expect(
      judge(
        'test',
        junit,
        '<testsuite><testcase name="slash /> still an attribute"><failure/></testcase></testsuite>',
      ).state,
    ).toBe('fail')
    expect(
      judge(
        'test',
        junit,
        '<testsuite><testcase name="ok"><system-out><![CDATA[<failure/>]]></system-out></testcase></testsuite>',
      ).state,
    ).toBe('pass')
    expect(() => judge('test', junit, '<testsuite><testcase name="truncated"/>')).toThrow()
  })

  it('rejects JSON evidence without nonnegative integer counts', () => {
    const json = { format: 'json', source: 'stdout' } as const
    for (const content of [
      '{"passed":-1,"failed":0,"skipped":0}',
      '{"passed":1,"failed":"0","skipped":0}',
      '{}',
      'null',
    ])
      expect(() => judge('test', json, content)).toThrow()
  })
})
