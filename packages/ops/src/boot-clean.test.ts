import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootClean, FINISHED_BY_REBOOT, gitBusyIn } from './boot-clean'
import type { DeployDeps } from './deploy'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const HOUR = 3_600_000
const bootMs = Date.now() - HOUR
const beforeBoot = (path: string) => {
  const at = new Date(bootMs - HOUR)
  utimesSync(path, at, at)
}
const written = (path: string, text: string, old = true) => {
  writeFileSync(path, text)
  if (old) beforeBoot(path)
  return path
}

function setup(projects: string[] = []) {
  const top = mkdtempSync(join(tmpdir(), 'aico-boot-clean-'))
  dirs.push(top)
  const out: string[] = []
  const calls: string[][] = []
  const fails = { restart: false, stopCode: 0 }
  const cwds = new Map<string, string | undefined>()
  const deps = {
    env: { AICO_HOOK_BIN: 'fake-hook', AICO_BIN: 'fake-aico' },
    releasesDir: join(top, 'releases'),
    jobsDir: join(top, 'deploys'),
    systemdDir: join(top, 'units'),
    opsLink: join(top, 'ops'),
    out: (line: string) => out.push(line),
    err: (line: string) => out.push(line),
    sleep: async () => {},
    run: (cmd: string, args: string[], opts?: { cwd?: string }) => {
      calls.push([cmd, ...args])
      cwds.set(cmd, opts?.cwd)
      if (cmd === 'fake-aico')
        return {
          code: 0,
          out: JSON.stringify(projects.map((root_path) => ({ id: 'aico', root_path }))),
          err: '',
        }
      if (args[1] === 'stop') return { code: fails.stopCode, out: '', err: 'not loaded' }
      if (fails.restart && args[1] === 'restart') return { code: 1, out: '', err: 'failed' }
      return { code: 0, out: '', err: '' }
    },
  } as unknown as DeployDeps
  for (const dir of [deps.releasesDir, deps.jobsDir, deps.systemdDir]) mkdirSync(dir)
  return { top, out, calls, fails, cwds, deps }
}

const job = (id: string, state: string) => ({ id, state, sha: 'a'.repeat(40), argv: [] })
const ids = { a: 'aico-aaaaaaaaaaaa', b: 'aico-bbbbbbbbbbbb', c: 'aico-cccccccccccc' }
const readRecord = (deps: DeployDeps, id: string) =>
  JSON.parse(readFileSync(join(deps.jobsDir, `${id}.json`), 'utf8'))

describe('deploy records', () => {
  it('fails what the boot ended and leaves the rest', async () => {
    const { deps, out } = setup()
    const record = (id: string, state: string, old = true) =>
      written(join(deps.jobsDir, `${id}.json`), JSON.stringify(job(id, state)), old)
    record(ids.a, 'running')
    record(ids.b, 'succeeded')
    record(ids.c, 'running', false) // started since this boot: a real deploy
    const broken = written(join(deps.jobsDir, 'aico-dddddddddddd.json'), '')

    await bootClean(deps, { bootMs })

    expect(readRecord(deps, ids.a)).toMatchObject({
      state: 'failed',
      message: FINISHED_BY_REBOOT,
      exit_code: 1,
    })
    expect(readRecord(deps, ids.b).state).toBe('succeeded')
    expect(readRecord(deps, ids.c).state).toBe('running')
    expect(existsSync(broken)).toBe(false)
    expect(out.filter((line) => line.includes(ids.a))).toHaveLength(1)
  })

  it('a record with no id is still cleared, and a bad one does not stop the rest', async () => {
    const { deps } = setup()
    written(join(deps.jobsDir, `${ids.a}.json`), JSON.stringify({ state: 'running' }))
    const lock = written(join(deps.releasesDir, '.deploy.pid'), '1 x\n')
    await bootClean(deps, { bootMs })
    expect(readRecord(deps, ids.a)).toMatchObject({ id: ids.a, state: 'failed' })
    expect(existsSync(lock)).toBe(false)
  })

  it('a dry run says the same and changes nothing, and an empty one says so', async () => {
    const quiet = setup()
    await bootClean(quiet.deps, { bootMs, dryRun: true })
    expect(quiet.out).toEqual(['[boot-clean] nothing left over from before this boot'])

    const { deps, out } = setup()
    written(join(deps.jobsDir, `${ids.a}.json`), JSON.stringify(job(ids.a, 'running')))
    await bootClean(deps, { bootMs, dryRun: true })
    expect(out.join('\n')).toMatch(/would mark deploy/)
    expect(readRecord(deps, ids.a).state).toBe('running')
  })
})

describe('a half-finished unit swap', () => {
  const journal = (deps: DeployDeps) => join(deps.releasesDir, '.swap.json')
  const swapped = (deps: DeployDeps, old = true) =>
    written(
      journal(deps),
      JSON.stringify({ sha: 'a'.repeat(40), previous: { 'demo.service': 'old unit' } }),
      old,
    )

  it('goes back to the previous units, so the next deploy has nothing to refuse', async () => {
    const { deps, calls, out } = setup()
    written(join(deps.systemdDir, 'demo.service'), 'half-swapped unit')
    swapped(deps)
    await bootClean(deps, { bootMs })
    expect(readFileSync(join(deps.systemdDir, 'demo.service'), 'utf8')).toBe('old unit')
    expect(existsSync(journal(deps))).toBe(false)
    expect(calls).toContainEqual(['systemctl', '--user', 'restart', 'demo.service'])
    expect(out.join('\n')).toMatch(/stopped mid-swap/)
  })

  it('leaves one from this boot alone: a deploy is running', async () => {
    const { deps, calls } = setup()
    swapped(deps, false)
    await bootClean(deps, { bootMs })
    expect(existsSync(journal(deps))).toBe(true)
    expect(calls.filter(([cmd]) => cmd === 'systemctl')).toEqual([])
  })

  it('clears a lock whose pid is now some other live process, instead of waiting on it', async () => {
    const { deps } = setup()
    const lock = written(join(deps.releasesDir, '.deploy.pid'), `${process.pid} before-boot\n`)
    swapped(deps)
    await bootClean(deps, { bootMs })
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(journal(deps))).toBe(false)
  })

  it('sets an empty journal aside; a unit that will not restart does not block the next deploy', async () => {
    const { deps, fails, out } = setup()
    written(journal(deps), '')
    await bootClean(deps, { bootMs })
    expect(existsSync(journal(deps))).toBe(false)
    expect(readdirSync(deps.releasesDir)).toContain('.swap.json.unreadable')

    swapped(deps)
    fails.restart = true
    await bootClean(deps, { bootMs })
    expect(existsSync(journal(deps))).toBe(false)
    expect(out.join('\n')).toMatch(/did not restart/)
  })

  it('a unit the swap was adding, never loaded, does not block anything', async () => {
    const { deps, fails } = setup()
    written(
      journal(deps),
      JSON.stringify({ sha: 'a'.repeat(40), previous: { 'new.service': null } }),
    )
    fails.stopCode = 5
    await bootClean(deps, { bootMs })
    expect(existsSync(journal(deps))).toBe(false)
  })

  it('a unit that really would not stop keeps the journal, and is tried once per boot', async () => {
    const { deps, fails, calls, out } = setup()
    written(
      journal(deps),
      JSON.stringify({ sha: 'a'.repeat(40), previous: { 'new.service': null } }),
    )
    fails.stopCode = 1
    await bootClean(deps, { bootMs })
    expect(existsSync(journal(deps))).toBe(true)
    expect(out.join('\n')).toMatch(/the next deploy tries again/)
    expect(out.join('\n')).not.toMatch(/nothing left over/)
    const tries = () => calls.filter((call) => call.includes('stop')).length
    expect(tries()).toBe(1)
    await bootClean(deps, { bootMs })
    expect(tries()).toBe(1)
  })

  it('checks holds from the Aico project, where they mean something', async () => {
    const { deps, cwds } = setup(['/srv/fake-aico-root'])
    swapped(deps)
    await bootClean(deps, { bootMs })
    expect(cwds.get('fake-hook')).toBe('/srv/fake-aico-root')
  })

  it('a page build that cannot be put back does not keep the journal', async () => {
    const { deps, top, out } = setup()
    written(
      journal(deps),
      JSON.stringify({
        sha: 'a'.repeat(40),
        previous: {},
        previousFrontends: { [join(top, 'no-such-folder', 'current')]: 'old-build' },
      }),
    )
    await bootClean(deps, { bootMs })
    expect(existsSync(journal(deps))).toBe(false)
    expect(out.join('\n')).toMatch(/could not put back the page builds/)
  })

  it('a dry run touches nothing, and a hold leaves it for the next deploy', async () => {
    const dry = setup()
    swapped(dry.deps)
    await bootClean(dry.deps, { bootMs, dryRun: true })
    expect(existsSync(journal(dry.deps))).toBe(true)
    expect(dry.calls.filter(([cmd]) => cmd === 'systemctl')).toEqual([])

    const held = setup()
    swapped(held.deps)
    const original = held.deps.run
    held.deps.run = (cmd, args, opts) =>
      cmd === 'fake-hook' ? { code: 1, out: 'hold deploy', err: '' } : original(cmd, args, opts)
    await bootClean(held.deps, { bootMs })
    expect(existsSync(journal(held.deps))).toBe(true)
    expect(held.out.join('\n')).toMatch(/hold deploy/)
  })
})

describe('stale git locks', () => {
  const git = (root: string, ...args: string[]) =>
    spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  function repo(top: string) {
    const root = join(top, 'project')
    mkdirSync(root)
    git(root, 'init', '-q')
    writeFileSync(join(root, 'file'), 'x')
    return root
  }

  it('removes one from before this boot, and git works again', async () => {
    const top = mkdtempSync(join(tmpdir(), 'aico-boot-clean-git-'))
    dirs.push(top)
    const root = repo(top)
    const { deps, out } = setup([root, join(top, 'gone')])
    const lock = written(join(root, '.git/index.lock'), '')
    expect(git(root, 'add', 'file').status).not.toBe(0)
    await bootClean(deps, { bootMs, gitBusy: () => false })
    expect(existsSync(lock)).toBe(false)
    expect(git(root, 'add', 'file').status).toBe(0)
    expect(out.filter((line) => line.includes('index.lock'))).toHaveLength(1)
  })

  it('leaves a lock from this boot, one git is working by, and any in a dry run', async () => {
    const top = mkdtempSync(join(tmpdir(), 'aico-boot-clean-git-'))
    dirs.push(top)
    const root = repo(top)
    const { deps } = setup([root])
    const lock = written(join(root, '.git/index.lock'), '', false)
    await bootClean(deps, { bootMs, gitBusy: () => false })
    expect(existsSync(lock)).toBe(true)
    beforeBoot(lock)
    await bootClean(deps, { bootMs, gitBusy: () => true })
    expect(existsSync(lock)).toBe(true)
    await bootClean(deps, { bootMs, dryRun: true, gitBusy: () => false })
    expect(existsSync(lock)).toBe(true)
  })

  it('sees a git process working in the checkout, and only that', () => {
    const proc = mkdtempSync(join(tmpdir(), 'aico-boot-clean-proc-'))
    dirs.push(proc)
    const add = (pid: string, comm: string, cwd: string) => {
      mkdirSync(join(proc, pid))
      writeFileSync(join(proc, pid, 'comm'), `${comm}\n`)
      symlinkSync(cwd, join(proc, pid, 'cwd'))
    }
    add('10', 'bash', '/repo')
    add('11', 'git', '/other')
    add('12', 'git', '/repo-two')
    expect(gitBusyIn('/repo', proc)).toBe(false)
    add('13', 'git', '/repo/packages')
    expect(gitBusyIn('/repo', proc)).toBe(true)
  })
})
