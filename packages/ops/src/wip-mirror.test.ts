import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import wipConfig from '../data/wip-mirror.json' with { type: 'json' }
import { run } from './sh'
import {
  fleetPeers,
  mirror,
  type Peer,
  restoreWip,
  summary,
  type WipConfig,
  type WipDeps,
  wip,
} from './wip-mirror'

let dir: string
let peerHome: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wip-test-'))
  peerHome = join(dir, 'peer-home')
  mkdirSync(peerHome)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

function repo(
  name: string,
  files: Record<string, string> = { 'a.txt': 'one\n' },
  date?: string,
): string {
  const root = join(dir, 'work', name)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text)
  git(root, 'add', '-A')
  execFileSync('git', ['commit', '-q', '-m', 'first'], {
    cwd: root,
    env: { ...env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  })
  return root
}

/** A peer that is a folder on this computer: scripts run with its HOME, git talks to a path. */
function fakePeer(name = 'gem', free = 10_000_000): Peer {
  return {
    name,
    exec: async (script) => {
      const body = script.startsWith('mkdir') ? fakeDisk(script, free) : script
      const out = spawnSync('sh', ['-c', `cd "${peerHome}" && ${body}`], { encoding: 'utf8' })
      return { code: out.status ?? 1, out: `${out.stdout}${out.stderr}` }
    },
    remote: (rel) => ({ url: join(peerHome, rel), env: {} }),
  }
}
/** The disk question answers with a chosen free size; everything else runs as written. */
function fakeDisk(script: string, free: number): string {
  const dirPart = /mkdir -p ('[^']*')\/('[^']*')/.exec(script)
  const m = dirPart?.[1] ?? "'x'"
  const machine = dirPart?.[2] ?? "'x'"
  return `mkdir -p ${m}/${machine} && echo "fs 1 1 ${free} 1% /" && du -sk ${m} && ls -1 ${m}/${machine}`
}

function deps(
  projects: { id: string; root: string }[],
  extra: Partial<WipDeps> = {},
  cfg: Partial<WipConfig> = {},
  peers: Peer[] = [fakePeer()],
): WipDeps {
  return {
    cfg: { ...wipConfig, ...cfg },
    git: run,
    machine: 'home',
    peers: async () => ({ peers, off: null }),
    projects: () => projects,
    localBootId: () => null,
    state: join(dir, 'state.json'),
    now: () => new Date(),
    ...extra,
  }
}
const mirrorRepo = (id: string) => join(peerHome, wipConfig.mirrorDir, 'home', `${id}.git`)
const refs = (id: string) =>
  git(mirrorRepo(id), 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean)

describe('wip mirror', () => {
  it('copies branches and uncommitted work without touching the repo', async () => {
    const root = repo('app')
    writeFileSync(join(root, 'a.txt'), 'one\nedited\n')
    writeFileSync(join(root, 'new.txt'), 'untracked\n')
    writeFileSync(join(root, '.env'), 'SECRET=1\n')
    git(root, 'branch', 'side')
    git(root, 'add', 'a.txt') // a staged change must stay staged
    writeFileSync(join(root, 'a.txt'), 'one\nedited\nmore\n')
    const snapshot = () => ({
      head: git(root, 'rev-parse', 'HEAD'),
      status: git(root, 'status', '--porcelain=v1', '--untracked-files=all'),
      index: readFileSync(join(root, '.git', 'index')).toString('hex'),
      stash: git(root, 'stash', 'list'),
      refs: git(root, 'for-each-ref'),
      files: readFileSync(join(root, 'a.txt'), 'utf8'),
    })
    const before = snapshot()
    const report = await mirror(deps([{ id: 'app', root }]))
    expect(snapshot()).toEqual(before)
    expect(report.problems).toEqual([])
    expect(report.mirrored).toEqual(['app'])
    expect(refs('app')).toEqual([
      'refs/aico/wip/home/heads/main',
      'refs/aico/wip/home/heads/side',
      'refs/aico/wip/home/stash/main',
    ])
    const stash = 'refs/aico/wip/home/stash/main'
    expect(git(mirrorRepo('app'), 'show', `${stash}:a.txt`)).toBe('one\nedited\nmore')
    expect(git(mirrorRepo('app'), 'show', `${stash}:new.txt`)).toBe('untracked')
    expect(git(mirrorRepo('app'), 'ls-tree', '--name-only', stash)).not.toContain('.env')
    expect(git(mirrorRepo('app'), 'rev-parse', `${stash}^`)).toBe(before.head)
  })

  it('skips a repo that has not changed, and drops a stash ref once the work is committed', async () => {
    const root = repo('app')
    writeFileSync(join(root, 'new.txt'), 'x\n')
    const d = deps([{ id: 'app', root }])
    await mirror(d)
    const again = await mirror(d)
    expect(again.mirrored).toEqual([])
    expect(again.unchanged).toBe(1)
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'second')
    const last = await mirror(d)
    expect(last.mirrored).toEqual(['app'])
    expect(refs('app')).toEqual(['refs/aico/wip/home/heads/main'])
    expect(git(mirrorRepo('app'), 'rev-parse', 'refs/aico/wip/home/heads/main')).toBe(
      git(root, 'rev-parse', 'HEAD'),
    )
  })

  it("never pushes to the repo's own remotes", async () => {
    const root = repo('app')
    const origin = join(dir, 'origin.git')
    git(dir, 'init', '-q', '--bare', origin)
    git(root, 'remote', 'add', 'origin', origin)
    writeFileSync(join(root, 'new.txt'), 'x\n')
    await mirror(deps([{ id: 'app', root }]))
    expect(git(origin, 'for-each-ref')).toBe('')
    expect(git(root, 'for-each-ref', 'refs/remotes')).toBe('')
  })

  it('names what it skips and why', async () => {
    const hunters = repo('neri-hunters')
    const huge = repo('huge')
    const messy = repo('messy')
    const old = repo('old', { 'a.txt': 'x\n' }, '2020-01-01T00:00:00Z')
    const pinned = repo('pinned', { 'a.txt': 'x\n' }, '2020-01-01T00:00:00Z')
    writeFileSync(join(messy, 'big.bin'), Buffer.alloc(300 * 1024))
    const notGit = join(dir, 'work', 'plain')
    mkdirSync(notGit, { recursive: true })
    const cfg = {
      maxRepoMb: 0,
      maxDirtyMb: 0,
      pinned: ['pinned'],
      skipPaths: [{ segment: 'neri-hunters', reason: 'case data' }],
    }
    // maxRepoMb 0 trips on every repo; the dirty-size case needs its own run below.
    const first = await mirror(
      deps(
        [
          { id: 'neri-hunters', root: hunters },
          { id: 'huge', root: huge },
          { id: 'old', root: old },
          { id: 'plain', root: notGit },
        ],
        {},
        cfg,
      ),
    )
    expect(first.problems.map((p) => p.reason)).toEqual([
      expect.stringMatching(/^huge: not copied, git data is .* \(limit 0 MB\)/),
    ])
    expect(first.idle).toBe(1)
    expect(existsSync(mirrorRepo('neri-hunters'))).toBe(false)
    const second = await mirror(
      deps(
        [
          { id: 'messy', root: messy },
          { id: 'pinned', root: pinned },
        ],
        {},
        { maxDirtyMb: 0, pinned: ['pinned'] },
      ),
    )
    expect(second.problems).toHaveLength(1)
    expect(second.problems[0]).toMatchObject({ state: 'warn', project: 'messy' })
    expect(second.problems[0]?.reason).toMatch(
      /uncommitted work is .*limit 0 MB.*only branches copied/,
    )
    expect(refs('messy')).toEqual(['refs/aico/wip/home/heads/main'])
    expect(refs('pinned')).toEqual(['refs/aico/wip/home/heads/main'])
    // The skip is still reported on a run where nothing changed.
    const third = await mirror(deps([{ id: 'messy', root: messy }], {}, { maxDirtyMb: 0 }))
    expect(third.problems.map((p) => p.project)).toEqual(['messy'])
  })

  it('refuses to fill a peer disk', async () => {
    const root = repo('app')
    const low = await mirror(deps([{ id: 'app', root }], {}, {}, [fakePeer('gem', 1000)]))
    expect(low.problems[0]?.reason).toMatch(/not copied to gem, it has .* free/)
    expect(existsSync(mirrorRepo('app'))).toBe(false)
    const full = await mirror(deps([{ id: 'app', root }], {}, { maxMirrorMb: 0 }, [fakePeer()]))
    expect(full.problems[0]?.reason).toMatch(/would pass 0 MB/)
  })

  it('reports a peer that does not answer as a failure', async () => {
    const root = repo('app')
    const down: Peer = { ...fakePeer('gem'), exec: async () => ({ code: 255, out: '' }) }
    const report = await mirror(deps([{ id: 'app', root }], {}, {}, [down]))
    expect(report.problems).toEqual([expect.objectContaining({ key: 'peer-gem', state: 'failed' })])
    expect(summary(report, 'home', 1)).toContain('Failed: gem did not answer')
  })

  it('does nothing and says so plainly when there is no peer', async () => {
    const root = repo('app')
    const report = await mirror(
      deps([{ id: 'app', root }], {
        peers: async () => ({ peers: [], off: 'Off: no other full Aico.' }),
      }),
    )
    expect(report).toMatchObject({ off: 'Off: no other full Aico.', problems: [] })
    expect(summary(report, 'home', 0)).toBe('Off: no other full Aico.')
  })

  it('refuses an unknown option instead of copying', async () => {
    await expect(wip(['run', '--dry-run'])).rejects.toThrow(/unknown option --dry-run/)
  })

  it('stays off without a fleet file', async () => {
    const { off, peers } = await fleetPeers(
      { localBootId: () => null },
      { AICO_FLEET_CONFIG: join(dir, 'none.json') },
    )()
    expect(peers).toEqual([])
    expect(off).toMatch(/not part of a fleet/)
  })

  it('only runs the named projects after a commit', async () => {
    const a = repo('a')
    const b = repo('b')
    const report = await mirror(
      deps(
        [
          { id: 'a', root: a },
          { id: 'b', root: b },
        ],
        { only: ['b'] },
      ),
    )
    expect(report.mirrored).toEqual(['b'])
    expect(existsSync(mirrorRepo('a'))).toBe(false)
  })

  it('restores the newest uncommitted work into a new folder', async () => {
    const root = repo('app')
    writeFileSync(join(root, 'a.txt'), 'one\nlost work\n')
    const d = deps([{ id: 'app', root }])
    await mirror(d)
    const target = join(dir, 'back')
    expect(await restoreWip(['app', '--to', target], d)).toBe(0)
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('one\nlost work\n')
    expect(git(target, 'branch', '--show-current')).toBe('wip-restored')
    await expect(restoreWip(['app', '--to', target], d)).rejects.toThrow(/already exists/)
  })
})
