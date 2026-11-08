import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from './cli'
import { commit } from './commit'
import { type Config, loadConfig } from './plan'
import { repairStages } from './repair'

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

/** Fails while any src file says BROKEN, wherever it runs. */
const SCAN =
  "const fs=require('fs');for(const f of fs.readdirSync('src'))if(fs.readFileSync('src/'+f,'utf8').includes('BROKEN')){console.error('error: BROKEN in src/'+f);process.exit(1)}"

function repo(stages: string, extra = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'aico-clean-test-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'Test')
  write(
    root,
    '.st-check.toml',
    `[native]\nlegacy_tools = []\n${extra}[native.tools]\nnode = ${JSON.stringify(process.execPath)}\n\n${stages}`,
  )
  write(root, 'src/a.ts', 'a\n')
  write(root, 'docs/readme.md', 'r\n')
  write(root, '.gitignore', '.dev-tools/\nnode_modules/\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

const scanStage = `[[native.stages]]\nid = "scan"\nkind = "check"\ncoverage = "full"\nquick = true\nargv = ["node", "-e", ${JSON.stringify(SCAN)}]\n`

function config(root: string): Config {
  const loaded = loadConfig(root)
  if ('unsupported' in loaded) throw new Error(loaded.unsupported)
  return loaded
}

const coordination = {
  foreign: () => ({}),
  guard: () => null,
  committed: () => '',
}

describe('a commit is judged on HEAD plus its files', () => {
  it('commits when only an unrelated dirty file breaks a stage, and leaves that file alone', async () => {
    const root = repo(scanStage)
    write(root, 'src/a.ts', 'a2\n')
    write(root, 'src/other.ts', 'BROKEN\n')
    write(root, 'docs/readme.md', 'staged by someone else\n')
    git(root, 'add', 'docs/readme.md')
    const lines: string[] = []
    const result = await commit(config(root), {
      message: 'Mine',
      paths: ['src/a.ts'],
      coordination,
      out: (line) => lines.push(line),
      env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: 'session-1' },
    })
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/a.ts')
    expect(lines.filter((line) => line.startsWith('CHECK:CLEAN:'))).toHaveLength(1)
    expect(lines.join('\n')).toContain('src/other.ts')
    expect(lines.join('\n')).not.toContain('CHECK:FAIL')
    expect(result.check?.passed).toBe(true)
    // Nobody's tree, index or stash changed, and the temporary worktree is gone.
    expect(readFileSync(join(root, 'src/other.ts'), 'utf8')).toBe('BROKEN\n')
    expect(git(root, 'status', '--porcelain', '--', 'docs', 'src')).toBe(
      'M  docs/readme.md\n?? src/other.ts',
    )
    expect(git(root, 'stash', 'list')).toBe('')
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    // Who made it, for a deploy that stops on it later.
    expect(
      JSON.parse(
        readFileSync(
          join(root, `.git/aico-checks/receipts/commit-session-${result.sha}.json`),
          'utf8',
        ),
      ),
    ).toEqual({ session: 'session-1' })
  })

  it('refuses when its own files break the stage, with that failure', async () => {
    const root = repo(scanStage)
    write(root, 'src/a.ts', 'BROKEN\n')
    write(root, 'docs/readme.md', 'someone else\n')
    const lines: string[] = []
    await expect(
      commit(config(root), {
        message: 'Mine',
        paths: ['src/a.ts'],
        coordination,
        out: (line) => lines.push(line),
        env: {},
      }),
    ).rejects.toThrow(/quick check failed on HEAD plus your files/)
    expect(lines.join('\n')).toContain('BROKEN in src/a.ts')
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  it('a removed file is gone from the clean copy', async () => {
    const root = repo(scanStage)
    write(root, 'src/bad.ts', 'BROKEN\n')
    git(root, 'add', 'src/bad.ts')
    await commit(config(root), {
      message: 'Broken one',
      paths: ['src/bad.ts'],
      noCheck: true,
      coordination,
      env: {},
    })
    rmSync(join(root, 'src/bad.ts'))
    write(root, 'docs/readme.md', 'someone else\n')
    await expect(
      commit(config(root), { message: 'Remove', paths: ['src/bad.ts'], coordination, env: {} }),
    ).resolves.toMatchObject({ files: ['src/bad.ts'] })
  })

  it('with no other dirty files there is no second run, and the old refusal stands', async () => {
    const root = repo(scanStage)
    write(root, 'src/a.ts', 'BROKEN\n')
    await expect(
      commit(config(root), { message: 'Mine', paths: ['src/a.ts'], coordination, env: {} }),
    ).rejects.toThrow('commit refused: the quick check failed (details above)')
  })

  it('says the fallback when the clean copy cannot be set up', async () => {
    const root = repo(scanStage)
    write(root, 'src/other.ts', 'BROKEN\n')
    write(root, 'src/a.ts', 'a2\n')
    await expect(
      commit(
        { ...config(root), declaredInputs: ['not/there'] },
        { message: 'Mine', paths: ['src/a.ts'], coordination, env: {} },
      ),
    ).rejects.toThrow(/could not be set up.*--skip-checks/)
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
  })

  it("refuses when a commit lands on a clean stage's inputs during its run", async () => {
    const root = repo('')
    const land = `const {execFileSync:x}=require('child_process');const fs=require('fs');const d=${JSON.stringify(root)};if(process.cwd()===d)process.exit(1);fs.writeFileSync(d+'/src/landed.ts','x');x('/usr/bin/git',['-C',d,'add','src/landed.ts']);x('/usr/bin/git',['-C',d,'-c','user.email=t@t','-c','user.name=t','commit','-qm','landed'])`
    write(
      root,
      '.st-check.toml',
      `[native]\nlegacy_tools = []\n[native.tools]\nnode = ${JSON.stringify(process.execPath)}\n\n[[native.stages]]\nid = "land"\nkind = "check"\ncoverage = "full"\nquick = true\ninputs = ["src"]\nargv = ["node", "-e", ${JSON.stringify(land)}]\n`,
    )
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'gate')
    write(root, 'src/a.ts', 'a2\n')
    write(root, 'docs/readme.md', 'someone else\n')
    await expect(
      commit(config(root), { message: 'Mine', paths: ['src/a.ts'], coordination, env: {} }),
    ).rejects.toThrow('source changed during the check: stage land inputs')
    expect(git(root, 'log', '-1', '--format=%s')).toBe('landed')
  })

  it('a stage whose inputs changed during the check is still refused', async () => {
    const racing =
      "const fs=require('fs');fs.writeFileSync('src/z.ts','changed mid-check');process.exit(0)"
    const root = repo(
      `[[native.stages]]\nid = "race"\nkind = "check"\ncoverage = "full"\nquick = true\ninputs = ["src"]\nargv = ["node", "-e", ${JSON.stringify(racing)}]\n`,
    )
    write(root, 'src/a.ts', 'a2\n')
    write(root, 'docs/readme.md', 'someone else\n')
    await expect(
      commit(config(root), { message: 'Mine', paths: ['src/a.ts'], coordination, env: {} }),
    ).rejects.toThrow(/quick check failed/)
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
  })
})

describe('a deploy repairing safe fixes', () => {
  const fake = (root: string) => {
    write(
      root,
      'node_modules/.bin/biome',
      `#!/bin/sh\nfor arg in "$@"; do case "$arg" in *.ts) sed -i 's/UGLY/nice/' "$arg";; esac; done\n`,
    )
    chmodSync(join(root, 'node_modules/.bin/biome'), 0o755)
  }
  const biomeStage = `[[native.stages]]\nid = "biome"\nkind = "check"\ncoverage = "full"\nargv = ["node_modules/.bin/biome", "check", "."]\n`
  const withEnv = 'environment_inputs = ["node_modules"]\n'
  const uglyRepo = (stages = biomeStage) => {
    const root = repo(stages, withEnv)
    fake(root)
    write(root, 'src/ugly.ts', 'UGLY\n')
    write(root, 'src/dirty.ts', 'UGLY\n')
    git(root, 'add', 'src')
    git(root, 'commit', '-qm', 'ugly')
    write(root, 'src/dirty.ts', 'UGLY and someone is editing\n')
    return root
  }

  it('commits the fix in clean files only and leaves a dirty file alone', async () => {
    const root = uglyRepo()
    const lines: string[] = []
    const code = await runCli('check', ['--repair', 'biome'], {
      cwd: root,
      env: {},
      out: (line: string) => lines.push(line),
      err: (line: string) => lines.push(line),
      coordination,
    })
    expect(code).toBe(0)
    expect(lines).toContain(`REPAIR:committed ${git(root, 'rev-parse', 'HEAD')}`)
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/ugly.ts')
    expect(readFileSync(join(root, 'src/ugly.ts'), 'utf8')).toBe('nice\n')
    expect(readFileSync(join(root, 'src/dirty.ts'), 'utf8')).toBe('UGLY and someone is editing\n')
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  it('does nothing when the stage is no fixer, or nothing could be fixed', async () => {
    const root = uglyRepo(biomeStage + scanStage)
    const head = git(root, 'rev-parse', 'HEAD')
    expect(await repairStages(config(root), ['scan'], { coordination, env: {} })).toBeNull()
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head)
    const code = await runCli('check', ['--repair', 'scan'], {
      cwd: root,
      env: {},
      out: () => {},
      err: () => {},
      coordination,
    })
    expect(code).toBe(1)
  })

  it('a refused repair puts back only its own rewrite', async () => {
    const root = uglyRepo()
    const refusing = {
      ...coordination,
      guard: () => {
        // Someone saves while the commit is deciding: that edit must survive.
        return 'hold by another agent'
      },
    }
    const head = git(root, 'rev-parse', 'HEAD')
    expect(
      await repairStages(config(root), ['biome'], { coordination: refusing, env: {} }),
    ).toBeNull()
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(root, 'src/ugly.ts'), 'utf8')).toBe('UGLY\n')
    expect(readFileSync(join(root, 'src/dirty.ts'), 'utf8')).toBe('UGLY and someone is editing\n')
  })

  it("a file saved during the repair stays its writer's", async () => {
    const root = uglyRepo()
    const saving = {
      ...coordination,
      guard: () => {
        write(root, 'src/ugly.ts', 'saved by someone\n')
        return 'hold by another agent'
      },
    }
    expect(
      await repairStages(config(root), ['biome'], { coordination: saving, env: {} }),
    ).toBeNull()
    expect(readFileSync(join(root, 'src/ugly.ts'), 'utf8')).toBe('saved by someone\n')
  })
})
