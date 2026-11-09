import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ProblemRow } from './caretaker'
import { shoppingRepairPass } from './shopping-repair'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const failure = (id: string): ProblemRow => ({
  id: `portfolio-ai/shopping-repair/provider/${id}`,
  what: 'Shopping repair',
  kind: 'job',
  machine: 'test',
  shown: 'failed',
  meaning: `Synthetic provider unavailable; capture ${id}`,
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'shopping-repair-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'project'))
  const calls: string[][] = []
  let launchFails = false
  let finished = 0
  let exited = false
  let routeRows = [
    {
      tool: 'antigravity',
      model: 'agy-model',
      use: true,
      allowed: true,
      launchable: true,
      usage: { status: 'untracked' },
    },
    {
      tool: 'codex',
      model: 'codex-model',
      effort: 'high',
      use: true,
      allowed: true,
      launchable: true,
      usage: { status: 'on_credits' },
    },
  ]
  const io = {
    dataDir: dir,
    projectRoot: join(dir, 'project'),
    log: (_text: string) => {},
    run: async (argv: string[]) => {
      calls.push(argv)
      if (argv[0] === 'env') argv = argv.slice(3)
      if (argv[0]?.endsWith('/scripts/vm-release.sh') && argv[1] === 'capabilities')
        return { code: 0, output: 'expected-base-v1' }
      if (argv[0]?.endsWith('/scripts/vm-release.sh'))
        return { code: 0, output: `[guest] current: release ${'a'.repeat(12)}` }
      if (argv[0] === 'git') {
        if (argv.includes('worktree')) mkdirSync(argv[6] as string, { recursive: true })
        if (argv.includes('--git-common-dir')) return { code: 0, output: '/test/common' }
        if (argv.includes('status')) return { code: 0, output: '' }
        if (argv.includes('rev-parse')) return { code: 0, output: 'a'.repeat(40) }
        return { code: 0, output: '' }
      }
      if (argv[1] === 'models') return { code: 0, output: JSON.stringify({ rows: routeRows }) }
      return argv[2] === 'create'
        ? { code: launchFails ? 1 : 0, output: launchFails ? 'unavailable' : '{}' }
        : {
            code: 0,
            output: JSON.stringify(
              exited
                ? { status: 'ended' }
                : finished
                  ? { state: 'idle', lastMessage: 'Needs verification', lastActivityAt: finished }
                  : { state: 'working' },
            ),
          }
    },
  }
  return {
    dir,
    io,
    calls,
    fail: () => {
      launchFails = true
    },
    recover: () => {
      launchFails = false
    },
    exit: () => {
      exited = true
    },
    subscription: () => {
      routeRows = routeRows.map((row) =>
        row.tool === 'codex' ? { ...row, usage: { status: 'ok' } } : row,
      )
    },
    alternate: () => {
      routeRows.push({
        tool: 'pi',
        model: 'provider/model',
        effort: 'high',
        use: false,
        allowed: true,
        launchable: true,
        usage: { status: 'ok' },
      })
    },
    finish: () => {
      finished += 1
    },
  }
}

it('coalesces synthetic provider failures, preserves evidence, and never calls completion healing', async () => {
  const h = fixture()
  const rows = [failure('one'), failure('two')]
  await shoppingRepairPass(rows, h.io)
  expect(h.calls.filter((c) => c[2] === 'create')).toHaveLength(1)
  const state = JSON.parse(readFileSync(join(h.dir, 'shopping-repair/state.json'), 'utf8'))
  dirs.push(dirname(state.areas.provider.active.staged))
  expect(JSON.parse(readFileSync(state.areas.provider.active.brief, 'utf8'))).toEqual(
    rows.map(({ id, what, meaning }) => ({ id, what, meaning })),
  )
  expect(readFileSync(state.areas.provider.active.staged, 'utf8')).toBe(
    readFileSync(state.areas.provider.active.brief, 'utf8'),
  )
  await Promise.all([shoppingRepairPass(rows, h.io), shoppingRepairPass(rows, h.io)])
  expect(h.calls.filter((c) => c[2] === 'create')).toHaveLength(1)
  h.finish()
  await shoppingRepairPass(rows, h.io)
  await shoppingRepairPass(rows, h.io)
  expect(h.calls.filter((c) => c[2] === 'create')).toHaveLength(1)
  expect(h.calls.filter((c) => c[2] === 'root' && c[3] === 'send')).toHaveLength(1)
  expect(rows.every((r) => r.shown === 'failed')).toBe(true)
  h.finish()
  await shoppingRepairPass(
    [...rows.map((row) => ({ ...row, shown: 'ok' })), failure('three')],
    h.io,
  )
  expect(h.calls.filter((c) => c[2] === 'create')).toHaveLength(2)
})

it('reuses the same root request after an uncertain launch and ignores off or unknown rows', async () => {
  const h = fixture()
  h.fail()
  const row = failure('one')
  await shoppingRepairPass([row], h.io)
  await shoppingRepairPass([{ ...row, machine_off: true, shown: 'off' }], h.io)
  expect(h.calls.filter((c) => c[2] === 'create')).toHaveLength(1)
  h.recover()
  await shoppingRepairPass([row], h.io)
  const creates = h.calls.filter((c) => c[2] === 'create')
  expect(creates).toHaveLength(2)
  expect(creates[0]).toEqual(creates[1])
  const other = fixture()
  await shoppingRepairPass(
    [
      { ...row, machine_off: true },
      { ...failure('two'), shown: 'unknown' },
      { ...failure('three'), shown: 'ok' },
    ],
    other.io,
  )
  expect(other.calls).toEqual([])
})

it('fails closed on corrupt state rather than dispatching a duplicate', async () => {
  const h = fixture()
  await shoppingRepairPass([failure('one')], h.io)
  writeFileSync(join(h.dir, 'shopping-repair/state.json'), '{broken')
  await expect(shoppingRepairPass([failure('one')], h.io)).rejects.toThrow()
  expect(h.calls.filter((c) => c[2] === 'create')).toHaveLength(1)
})

it('falls back only after a terminated root and with a live subscription', async () => {
  const h = fixture()
  const row = failure('one')
  await shoppingRepairPass([row], h.io)
  h.exit()
  await shoppingRepairPass([row], h.io)
  expect(h.calls.filter((c) => c[2] === 'create')).toHaveLength(1)
  h.subscription()
  await shoppingRepairPass([row], h.io)
  const creates = h.calls.filter((c) => c[2] === 'create')
  expect(creates).toHaveLength(2)
  expect(creates[1]).toContain('agy')
  expect(creates[1]?.[3]).not.toBe(creates[0]?.[3])
})

it('uses a permitted subscription fallback after an agent exits', async () => {
  const h = fixture()
  await shoppingRepairPass([failure('one')], h.io)
  h.subscription()
  h.exit()
  await shoppingRepairPass([failure('one')], h.io)
  const creates = h.calls.filter((c) => c[2] === 'create')
  expect(creates).toHaveLength(2)
  expect(creates[1]).toContain('codex')
  expect(creates[1]).toContain('codex-model')
})

it('releases a pinned accepted commit, queues both durable replays, and waits for observed recovery', async () => {
  const h = fixture()
  const row = failure('one')
  await shoppingRepairPass([row], h.io)
  const statePath = join(h.dir, 'shopping-repair/state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const active = state.areas.provider.active
  const base = 'a'.repeat(40)
  const commit = 'b'.repeat(40)
  active.phase = 'accepted'
  active.handoff = { base, commit, files: ['backend/app/shopping.py'], requests: ['one'] }
  active.acceptance = { tree: 'c'.repeat(40), receipt: '/accept.json' }
  writeFileSync(statePath, JSON.stringify(state))
  writeFileSync(
    join(active.releaseWorktree, 'project.identity.json'),
    JSON.stringify({
      runtime: {
        backend_port: 8000,
        deployment: { kind: 'proxmox', ssh_host: 'pve', vmid: 180, user: 'operator' },
      },
    }),
  )
  let released = false
  const calls: string[][] = []
  const io = {
    ...h.io,
    sshAuthSock: '/run/user/1000/ssh',
    run: async (argv: string[]) => {
      calls.push(argv)
      if (argv[0] === 'env') argv = argv.slice(3)
      if (argv[0]?.endsWith('/scripts/vm-release.sh') && argv[1] === 'capabilities')
        return { code: 0, output: 'expected-base-v1' }
      if (argv[0]?.endsWith('/scripts/vm-release.sh'))
        return {
          code: 0,
          output: `[guest] current: release ${(released ? commit : base).slice(0, 12)}`,
        }
      if (argv[0] === 'git') {
        if (argv.includes('status')) return { code: 0, output: '' }
        if (argv.includes('HEAD^{commit}'))
          return { code: 0, output: argv[2] === active.releaseWorktree ? base : commit }
        return { code: 0, output: released ? commit : base }
      }
      if (argv[0] === 'systemd-run') {
        released = true
        return { code: 0, output: '' }
      }
      if (argv[0] === 'systemctl')
        return {
          code: 0,
          output:
            'LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\nResult=success\nExecMainStatus=0',
        }
      if (argv.includes('network-get-interfaces'))
        return {
          code: 0,
          output: JSON.stringify([
            {
              name: 'eth0',
              'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '10.1.2.3' }],
            },
          ]),
        }
      if (argv[0] === 'ssh') {
        const replay = argv.includes('dadbot')
          ? argv[argv.indexOf('one') + 1]
          : JSON.parse((argv[argv.indexOf('--data') + 1] as string).slice(1, -1)).replay_id
        return {
          code: 0,
          output: JSON.stringify({
            request_id: 'one',
            replay_id: replay,
            state: argv.includes('dadbot') ? 'queued' : 'pending',
          }),
        }
      }
      return { code: 1, output: '' }
    },
  }
  await shoppingRepairPass([row], io)
  expect(JSON.parse(readFileSync(statePath, 'utf8')).areas.provider.active.phase).toBe('releasing')
  await shoppingRepairPass([row], io)
  expect(JSON.parse(readFileSync(statePath, 'utf8')).areas.provider.active.phase).toBe('waiting')
  expect(
    JSON.parse(readFileSync(join(h.dir, `shopping-repair/${active.id}-release.json`), 'utf8'))
      .jobResult,
  ).toBe('success')
  await shoppingRepairPass([row], io)
  expect(calls.filter((args) => args.includes('systemd-run'))).toHaveLength(1)
  await shoppingRepairPass([{ ...row, shown: 'ok' }], io)
  expect(JSON.parse(readFileSync(statePath, 'utf8')).areas.provider.active).toBeUndefined()
})

it('gives a failed acceptance back to a new agent in the same repair checkout', async () => {
  const h = fixture()
  const row = failure('one')
  await shoppingRepairPass([row], h.io)
  const statePath = join(h.dir, 'shopping-repair/state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const active = state.areas.provider.active
  active.phase = 'accepting'
  active.handoff = {
    base: 'a'.repeat(40),
    commit: 'b'.repeat(40),
    files: ['backend/app/shopping.py'],
    requests: ['one'],
  }
  writeFileSync(statePath, JSON.stringify(state))
  const io = {
    ...h.io,
    run: async (argv: string[]) => {
      if (argv[0] === 'st' && argv[1] === 'check') return { code: 1, output: 'failed' }
      return h.io.run(argv)
    },
  }
  await shoppingRepairPass([row], io)
  expect(JSON.parse(readFileSync(statePath, 'utf8')).areas.provider.active.phase).toBe('retrying')
  await shoppingRepairPass([row], io)
  const creates = h.calls.filter((args) => args[2] === 'create')
  expect(creates).toHaveLength(2)
  expect(creates[1]?.[3]).not.toBe(creates[0]?.[3])
  expect(creates[1]).toContain(active.worktree)
  expect(creates[1]?.[4]).toContain('full acceptance gate failed')
})

it('uses a permitted lower-priority subscription route when the preferred agent exits', async () => {
  const h = fixture()
  await shoppingRepairPass([failure('one')], h.io)
  h.alternate()
  h.exit()
  await shoppingRepairPass([failure('one')], h.io)
  const creates = h.calls.filter((args) => args[2] === 'create')
  expect(creates).toHaveLength(2)
  expect(creates[1]).toContain('pi')
  expect(creates[1]).toContain('provider/model')
  expect(creates[1]).not.toContain('codex')
})

it('routes origin faults to their registered project and independently gates host power', async () => {
  const h = fixture()
  const dadbot = join(h.dir, 'dadbot')
  mkdirSync(dadbot)
  const row = {
    ...failure('origin'),
    id: 'portfolio-ai/shopping-repair/dadbot/origin',
    state: 'failed',
  }
  let power: 'on' | 'off' | 'unknown' = 'unknown'
  const io = {
    ...h.io,
    projects: [{ id: 'dadbot', root: dadbot }],
    power: async (machine: string) => {
      expect(machine).toBe('dadbot')
      return power
    },
    run: async (argv: string[]) => {
      if (argv[0] === 'ssh' && argv.includes('/srv/dadbot/app/release.json'))
        return { code: 0, output: JSON.stringify({ sha: 'a'.repeat(40) }) }
      return h.io.run(argv)
    },
  }
  await shoppingRepairPass([row], io)
  power = 'off'
  await shoppingRepairPass([row], io)
  expect(h.calls.some((args) => args.includes('create'))).toBe(false)
  power = 'on'
  await shoppingRepairPass([{ ...row, shown: 'off', machine_off: true }], io)
  const launch = h.calls.find((args) => args[2] === 'create')
  expect(launch?.[launch.indexOf('--project') + 1]).toBe('dadbot')
  expect(launch?.[launch.indexOf('--project-root') + 1]).toContain('.shopping-repair-worktrees/')
  expect(h.calls.find((args) => args[1] === 'models')?.[6]).toBe('dadbot')
})

it('prefers a correlated origin over a Portfolio symptom and coalesces active work', async () => {
  const h = fixture()
  const aico = join(h.dir, 'aico')
  mkdirSync(aico)
  const origin = {
    ...failure('same'),
    id: 'portfolio-ai/shopping-repair/aico/same',
    machine: 'workstation',
    state: 'failed',
  }
  const io = {
    ...h.io,
    projects: [{ id: 'aico', root: aico }],
    power: async () => 'on' as const,
    run: async (argv: string[]) => {
      if (argv[0] === 'st' && argv[1] === 'service')
        return { code: 0, output: `aico release=${'a'.repeat(12)}` }
      return h.io.run(argv)
    },
  }
  await shoppingRepairPass([failure('same'), origin], io)
  const launches = h.calls.filter((args) => args[2] === 'create')
  expect(launches).toHaveLength(1)
  expect(launches[0]?.[launches[0].indexOf('--project') + 1]).toBe('aico')
  await shoppingRepairPass([failure('same'), origin], io)
  expect(h.calls.filter((args) => args[2] === 'create')).toHaveLength(1)
})

it('uses a pinned Portfolio checkout for replay after a repair in another project', async () => {
  const h = fixture()
  const dadbot = join(h.dir, 'dadbot')
  mkdirSync(dadbot)
  const row = {
    ...failure('replay'),
    id: 'portfolio-ai/shopping-repair/dadbot/replay',
    state: 'failed',
  }
  const base = 'a'.repeat(40)
  const io = {
    ...h.io,
    projects: [{ id: 'dadbot', root: dadbot }],
    power: async () => 'on' as const,
    run: async (argv: string[]) => {
      if (argv[0] === 'ssh' && argv.includes('/srv/dadbot/app/release.json'))
        return { code: 0, output: JSON.stringify({ sha: base }) }
      if (argv[0] === 'git' && argv.includes('worktree')) {
        const tree = argv[6] as string
        mkdirSync(tree, { recursive: true })
        writeFileSync(
          join(tree, 'project.identity.json'),
          JSON.stringify({
            runtime: {
              backend_port: 8000,
              deployment: { kind: 'proxmox', ssh_host: 'pve', vmid: 180, user: 'operator' },
            },
          }),
        )
        return { code: 0, output: '' }
      }
      if (argv.includes('network-get-interfaces'))
        return {
          code: 0,
          output: JSON.stringify([
            {
              name: 'eth0',
              'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '10.1.2.3' }],
            },
          ]),
        }
      if (argv[0] === 'ssh') {
        const replay = argv.includes('dadbot')
          ? argv[argv.indexOf('replay') + 1]
          : JSON.parse((argv[argv.indexOf('--data') + 1] as string).slice(1, -1)).replay_id
        return {
          code: 0,
          output: JSON.stringify({
            request_id: 'replay',
            replay_id: replay,
            state: argv.includes('dadbot') ? 'queued' : 'pending',
          }),
        }
      }
      return h.io.run(argv)
    },
  }
  await shoppingRepairPass([row], io)
  const path = join(h.dir, 'shopping-repair/state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  const active = state.areas.dadbot.active
  active.phase = 'replaying'
  active.handoff = { base, commit: 'b'.repeat(40), files: ['file'], requests: ['replay'] }
  writeFileSync(path, JSON.stringify(state))
  await shoppingRepairPass([row], io)
  const updated = JSON.parse(readFileSync(path, 'utf8')).areas.dadbot.active
  expect(updated.phase).toBe('waiting')
  expect(updated.replayBase).toBe(base)
  expect(updated.replayWorktree).not.toBe(updated.worktree)
  expect(readFileSync(join(updated.replayWorktree, 'project.identity.json'), 'utf8')).toContain(
    'pve',
  )
})

it('persists a diagnostic correction and restarts in the verified target project without clearing the incident', async () => {
  const h = fixture()
  const dadbot = join(h.dir, 'dadbot')
  mkdirSync(dadbot)
  const row = {
    ...failure('correct'),
    id: 'portfolio-ai/shopping-repair/dadbot/correct',
    state: 'failed',
  }
  const io = {
    ...h.io,
    projects: [{ id: 'dadbot', root: dadbot }],
    power: async () => 'on' as const,
    run: async (argv: string[]) => {
      if (argv[0] === 'ssh' && argv.includes('/srv/dadbot/app/release.json'))
        return { code: 0, output: JSON.stringify({ sha: 'a'.repeat(40) }) }
      return h.io.run(argv)
    },
  }
  await shoppingRepairPass([row], io)
  const path = join(h.dir, 'shopping-repair/state.json')
  let state = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(
    join(dirname(state.areas.dadbot.active.staged), 'handoff.json'),
    JSON.stringify({
      version: 1,
      kind: 'origin_correction',
      project: 'portfolio-ai',
      category: 'portfolio_internal_error',
      evidence: 'Portfolio returned an internal error',
      requests: ['correct'],
    }),
  )
  h.finish()
  await shoppingRepairPass([row], io)
  state = JSON.parse(readFileSync(path, 'utf8'))
  expect(state.areas.dadbot.active.phase).toBe('redirecting')
  expect(state.areas.dadbot.active.correction.project).toBe('portfolio-ai')
  h.exit()
  await shoppingRepairPass([row], io)
  expect(JSON.parse(readFileSync(path, 'utf8')).areas.dadbot.active.phase).toBe('preparing')
  await shoppingRepairPass([row], io)
  const launches = h.calls.filter((args) => args[2] === 'create')
  expect(launches).toHaveLength(2)
  expect(launches[1]?.[launches[1].indexOf('--project') + 1]).toBe('portfolio-ai')
  expect(launches[1]?.[4]).toContain('Independently verify this evidence')
  expect(JSON.parse(readFileSync(path, 'utf8')).areas.dadbot.active.correction.category).toBe(
    'portfolio_internal_error',
  )
})
