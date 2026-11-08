import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, readQuery } from '@aico/store'
import { afterEach, beforeEach, expect, test } from 'vitest'
import copiesConfig from '../data/session-copies.json' with { type: 'json' }
import {
  answerSizes,
  type CopiesConfig,
  type CopyPeer,
  eligibleSessions,
  type HeldOptions,
  type LiveRecord,
  listLines,
  pruneCopies,
  readHeld,
  receiveBatch,
  type SendDeps,
  saidFromEvents,
  sendPass,
  showLines,
  transcriptFiles,
} from './session-copies'

const MB = 1024 * 1024
let root: string
let home: string
let held: string
let statePath: string
let now: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aico-shift-test-'))
  home = join(root, 'home')
  held = join(root, 'held')
  statePath = join(root, 'sent.json')
  now = Date.now()
  mkdirSync(home)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const cfg = (over: Partial<CopiesConfig> = {}): CopiesConfig => ({ ...copiesConfig, ...over })

const claudeFile = (id: string) =>
  join(home, '.claude', 'projects', '-srv-workspaces-projects-aico', `${id}.jsonl`)

function writeClaude(id: string, text: string): string {
  const path = claudeFile(id)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

const record = (over: Partial<LiveRecord> = {}): LiveRecord => ({
  id: 'aaaa1111',
  status: 'running',
  tool: 'claude-code',
  host: null,
  displayTitle: 'Some work',
  projectId: 'aico',
  projectRoot: '/srv/workspaces/projects/aico',
  state: 'working',
  doing: 'Writing tests',
  stateAt: now,
  createdAt: now - 1000,
  ...over,
})

interface Link {
  peer: CopyPeer
  calls: { args: string[]; bytes: number }[]
  up: boolean
  free: number
}

/** The real receiving code behind a stand-in for the fleet link. */
function link(config: CopiesConfig, name = 'standby'): Link {
  const state: Link = {
    calls: [],
    up: true,
    free: 100 * 1024 * MB,
    peer: {
      name,
      call: async (args, input) => {
        state.calls.push({ args, bytes: input.length })
        if (!state.up) return { code: 255, stdout: '', output: '', ended: false }
        const options: HeldOptions = {
          dir: held,
          cfg: config,
          now,
          freeBytes: () => state.free,
        }
        const answer =
          args[0] === 'sizes'
            ? answerSizes(JSON.parse(input.toString('utf8')), options)
            : receiveBatch(input, options)
        return { code: 0, stdout: `${JSON.stringify(answer)}\n`, output: '', ended: true }
      },
    },
  }
  return state
}

function deps(config: CopiesConfig, peer: Link | null, over: Partial<SendDeps> = {}): SendDeps {
  return {
    cfg: config,
    machine: 'workstation',
    home,
    statePath,
    now: () => now,
    sessions: () => [record()],
    roles: () => new Map(),
    resumeIds: () => new Map([['aaaa1111', 'conv-1']]),
    said: () => ({ owner: { at: 1, text: 'fix it' }, agent: { at: 2, text: 'on it' } }),
    git: () => ({ branch: 'main', head: 'abc123', dirty: 3 }),
    peers: () => (peer ? { peers: [peer.peer], off: null } : { peers: [], off: 'Off: no peer.' }),
    wip: () => {},
    ...over,
  }
}

const copyOf = (id: string, session = 'aaaa1111') =>
  join(
    held,
    'workstation',
    'sessions',
    session,
    'files',
    '.claude/projects/-srv-workspaces-projects-aico',
    `${id}.jsonl`,
  )

test('sessions that may leave: running agents here, never a shell, a Neri project or a hunter', () => {
  const roles = new Map<string, string | null>([
    ['r-hunt', 'hunter'],
    ['r-work', 'developer'],
  ])
  const ids = (list: LiveRecord[]) => list.map((entry) => entry.id)
  const all = [
    record({ id: 'keep' }),
    record({ id: 'role-ok', rootRequestId: 'r-work' }),
    record({ id: 'shell', tool: 'shell' }),
    record({ id: 'other-host', host: 'aico' }),
    record({ id: 'ended', status: 'ended' }),
    record({ id: 'neri', projectId: 'neri' }),
    record({ id: 'hunters', projectId: 'neri-hunters' }),
    record({ id: 'path', projectId: 'x', projectRoot: '/srv/workspaces/neri-hunters/case' }),
    record({ id: 'hunter', rootRequestId: 'r-hunt' }),
  ]
  expect(ids(eligibleSessions(all, roles, cfg()))).toEqual(['keep', 'role-ok'])
  // Roles couldn't be read: anything with a role stays home.
  expect(ids(eligibleSessions(all, null, cfg()))).toEqual(['keep'])
})

test('only the new bytes go, and nothing at all while nothing changed', async () => {
  const path = writeClaude('conv-1', 'line one\n')
  const config = cfg()
  const peer = link(config)
  const wip: string[][] = []
  const first = await sendPass(deps(config, peer, { wip: (p) => wip.push(p) }))
  expect(first.failed).toBe(false)
  expect(readFileSync(copyOf('conv-1'), 'utf8')).toBe('line one\n')
  expect(wip).toEqual([['aico']])

  // Nothing changed: the peer isn't asked anything.
  peer.calls.length = 0
  const quiet = await sendPass(deps(config, peer, { wip: (p) => wip.push(p) }))
  expect(quiet.contacted).toBe(false)
  expect(peer.calls).toEqual([])
  expect(wip).toHaveLength(1)

  // Grew: the batch is the header and the new line, not the whole file again.
  const long = `${'x'.repeat(200_000)}\n`
  appendFileSync(path, 'line two\n')
  appendFileSync(path, long)
  await sendPass(deps(config, peer))
  expect(readFileSync(copyOf('conv-1'), 'utf8')).toBe(`line one\nline two\n${long}`)
  const received = peer.calls.find((call) => call.args[0] === 'receive')
  expect(received?.bytes).toBeLessThan(long.length + 2000)

  appendFileSync(path, 'line three\n')
  peer.calls.length = 0
  await sendPass(deps(config, peer))
  expect(peer.calls.find((call) => call.args[0] === 'receive')?.bytes).toBeLessThan(2000)
})

test('a rewritten conversation is sent again rather than appended to', async () => {
  const path = writeClaude('conv-1', 'first version of the conversation\n')
  const config = cfg()
  const peer = link(config)
  await sendPass(deps(config, peer))
  writeFileSync(path, 'SECOND version of the conversation, longer than it was\n')
  await sendPass(deps(config, peer))
  expect(readFileSync(copyOf('conv-1'), 'utf8')).toBe(
    'SECOND version of the conversation, longer than it was\n',
  )
})

test('the survivor reads what was going on, and copies are private and out of backups', async () => {
  writeClaude('conv-1', 'line one\n')
  const config = cfg()
  await sendPass(deps(config, link(config)))
  const machines = readHeld(held)
  expect(machines).toHaveLength(1)
  const machine = machines[0] as (typeof machines)[number]
  expect(machine.machine).toBe('workstation')
  const session = machine.sessions[0] as (typeof machine.sessions)[number]
  expect(session).toMatchObject({
    id: 'aaaa1111',
    tool: 'claude-code',
    title: 'Some work',
    project: 'aico',
    state: 'working',
    doing: 'Writing tests',
    lastOwner: { text: 'fix it' },
    lastAgent: { text: 'on it' },
    git: { branch: 'main', dirty: 3 },
  })
  expect(session.copy?.bytes).toBe(9)
  expect(listLines(machines, now).join('\n')).toContain('aaaa1111  working')
  expect(showLines(machine, session).join('\n')).toContain(
    'aico wip restore aico --of workstation --to DIR',
  )
  for (const dir of [
    held,
    join(held, 'workstation'),
    join(held, 'workstation', 'sessions', 'aaaa1111'),
  ])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(copyOf('conv-1')).mode & 0o077).toBe(0)
  expect(statSync(join(held, 'workstation', 'snapshot.json')).mode & 0o077).toBe(0)
  expect(existsSync(join(held, '.nobackup'))).toBe(true)
})

test('link down: quiet, nothing failed, the last copy stays readable, the next run catches up', async () => {
  const path = writeClaude('conv-1', 'line one\n')
  const config = cfg()
  const peer = link(config)
  await sendPass(deps(config, peer))
  peer.up = false
  appendFileSync(path, 'line two\n')
  const down = await sendPass(deps(config, peer))
  expect(down.failed).toBe(false)
  expect(down.lines.join()).toContain('not connected')
  expect(readHeld(held)[0]?.sessions[0]?.copy?.bytes).toBe(9)
  peer.up = true
  const back = await sendPass(deps(config, peer))
  expect(back.failed).toBe(false)
  expect(readFileSync(copyOf('conv-1'), 'utf8')).toBe('line one\nline two\n')
})

test('a peer that answers with a real error fails; one without this release yet stays quiet', async () => {
  writeClaude('conv-1', 'line one\n')
  const config = cfg()
  const answering = (output: string, code: number): CopyPeer => ({
    name: 'standby',
    call: async () => ({ code, stdout: '', output, ended: true }),
  })
  const run = (peer: CopyPeer) =>
    sendPass(deps(config, null, { peers: () => ({ peers: [peer], off: null }) }))
  expect((await run(answering('disk broke', 1))).failed).toBe(true)
  rmSync(statePath, { force: true })
  expect((await run(answering('aico: Unknown command shift', 2))).failed).toBe(false)
})

test('Tether not answering sends nothing, so the survivor keeps the last list', async () => {
  writeClaude('conv-1', 'line one\n')
  const config = cfg()
  const peer = link(config)
  await sendPass(deps(config, peer))
  peer.calls.length = 0
  const pass = await sendPass(deps(config, peer, { sessions: () => null }))
  expect(pass.failed).toBe(false)
  expect(peer.calls).toEqual([])
  expect(readHeld(held)[0]?.sessions).toHaveLength(1)
})

test('no peer is off and quiet', async () => {
  const pass = await sendPass(deps(cfg(), null))
  expect(pass).toMatchObject({ failed: false, contacted: false, lines: ['Off: no peer.'] })
})

test('a session over its cap keeps its latest whole lines and logs what went', async () => {
  const config = cfg({ maxSessionMb: 1, maxPassMb: 16 })
  const line = `${'a'.repeat(999)}\n`
  const path = writeClaude('conv-1', line.repeat(900))
  const peer = link(config)
  await sendPass(deps(config, peer))
  expect(statSync(copyOf('conv-1')).size).toBe(900_000)
  // Past the cap on the receiver: the oldest lines go and it keeps appending from there.
  appendFileSync(path, line.repeat(300))
  await sendPass(deps(config, peer))
  const first = statSync(copyOf('conv-1')).size
  expect(first).toBeLessThanOrEqual(MB)
  const text = readFileSync(copyOf('conv-1'), 'utf8')
  expect(text.startsWith('a')).toBe(true)
  expect(text.endsWith('\n')).toBe(true)
  const log = readFileSync(join(held, 'removed.log'), 'utf8')
  expect(log).toContain('oldest lines')
  expect(readHeld(held)[0]?.sessions[0]?.copy?.cut).toBe(true)
  appendFileSync(path, 'after the cut\n')
  await sendPass(deps(config, peer))
  expect(readFileSync(copyOf('conv-1'), 'utf8').endsWith('after the cut\n')).toBe(true)
  // A file already far over the cap starts from the part within it.
  writeClaude('conv-2', line.repeat(3000))
  const sessions = () => [record(), record({ id: 'bbbb2222' })]
  await sendPass(
    deps(config, peer, {
      sessions,
      resumeIds: () =>
        new Map([
          ['aaaa1111', 'conv-1'],
          ['bbbb2222', 'conv-2'],
        ]),
    }),
  )
  expect(statSync(copyOf('conv-2', 'bbbb2222')).size).toBeLessThanOrEqual(MB)
})

test('the total stays under its cap whatever arrives: ended copies first, each logged', async () => {
  const config = cfg({ maxSessionMb: 1, maxTotalMb: 3, maxPassMb: 64, batchMb: 1 })
  const peer = link(config)
  const line = `${'b'.repeat(999)}\n`
  const session = (id: string) => record({ id })
  const ids: string[] = []
  for (let i = 0; i < 8; i++) {
    const id = `sess${i}`
    ids.push(id)
    writeClaude(`conv-${i}`, line.repeat(900))
    now += 1000
    await sendPass(
      deps(config, peer, {
        // Each pass has one live session: the earlier ones ended.
        sessions: () => [session(id)],
        resumeIds: () => new Map([[id, `conv-${i}`]]),
      }),
    )
  }
  const total = ids.reduce((sum, id) => {
    const file = copyOf(`conv-${ids.indexOf(id)}`, id)
    return sum + (existsSync(file) ? statSync(file).size : 0)
  }, 0)
  expect(total).toBeLessThanOrEqual(3 * MB)
  // The live session is still there; the removals are in the log.
  expect(existsSync(copyOf('conv-7', 'sess7'))).toBe(true)
  const log = readFileSync(join(held, 'removed.log'), 'utf8').trim().split('\n')
  expect(log.length).toBeGreaterThanOrEqual(5)
  expect(JSON.parse(log[0] as string)).toMatchObject({
    machine: 'workstation',
    why: expect.stringContaining('over'),
  })
})

test('an ended copy goes after its time, counted only on a pass from its own machine', async () => {
  writeClaude('conv-1', 'line one\n')
  const config = cfg({ keepEndedHours: 1 })
  const peer = link(config)
  await sendPass(deps(config, peer))
  // The machine went off holding this session: however long, the copy stays.
  const options: HeldOptions = {
    dir: held,
    cfg: config,
    now: now + 1000 * 3_600_000,
    freeBytes: () => 100 * 1024 * MB,
  }
  expect(pruneCopies(options, null)).toEqual([])
  expect(pruneCopies(options, 'other')).toEqual([])
  expect(existsSync(copyOf('conv-1'))).toBe(true)
  // It came back and that session is over: the copy goes.
  now += 2 * 3_600_000
  const later = await sendPass(deps(config, peer, { sessions: () => [] }))
  expect(later.lines.join()).toContain('removed')
  expect(existsSync(copyOf('conv-1'))).toBe(false)
  expect(readFileSync(join(held, 'removed.log'), 'utf8')).toContain('ended more than 1 hours ago')
})

test('with the disk low only the list goes and the sender says so; old ended copies go first', async () => {
  const config = cfg()
  const peer = link(config)
  peer.free = 100 * MB
  writeClaude('conv-1', 'line one\n')
  const pass = await sendPass(deps(config, peer))
  expect(pass.failed).toBe(false)
  expect(pass.lines.join()).toContain('only the list went')
  expect(existsSync(copyOf('conv-1'))).toBe(false)
  expect(readHeld(held)[0]?.sessions[0]?.copy).toBeNull()
})

test('a pass sends at most its budget; the next pass carries on from there', async () => {
  const config = cfg({ maxPassMb: 1, batchMb: 1 })
  const peer = link(config)
  const line = `${'c'.repeat(999)}\n`
  writeClaude('conv-1', line.repeat(2500))
  const first = await sendPass(deps(config, peer))
  expect(first.lines.join()).toContain('the rest goes next run')
  expect(statSync(copyOf('conv-1')).size).toBe(MB)
  await sendPass(deps(config, peer))
  await sendPass(deps(config, peer))
  expect(statSync(copyOf('conv-1')).size).toBe(line.length * 2500)
  peer.calls.length = 0
  await sendPass(deps(config, peer))
  expect(peer.calls).toEqual([])
})

test('subagents go newest first within the cap; a long-finished one stays home', async () => {
  const config = cfg({ maxSessionMb: 1 })
  writeClaude('conv-1', 'main\n')
  const subs = join(home, '.claude/projects/-srv-workspaces-projects-aico/conv-1/subagents')
  mkdirSync(subs, { recursive: true })
  writeFileSync(join(subs, 'agent-new.jsonl'), 'new\n')
  writeFileSync(join(subs, 'agent-big.jsonl'), 'z'.repeat(2 * MB))
  writeFileSync(join(subs, 'agent-old.jsonl'), 'old\n')
  const old = (now - 2 * config.activeWindowMin * 60_000) / 1000
  utimesSync(join(subs, 'agent-old.jsonl'), old, old)
  await sendPass(deps(config, link(config)))
  const copies = join(
    held,
    'workstation/sessions/aaaa1111/files/.claude/projects/-srv-workspaces-projects-aico/conv-1/subagents',
  )
  expect(existsSync(join(copies, 'agent-new.jsonl'))).toBe(true)
  expect(existsSync(join(copies, 'agent-old.jsonl'))).toBe(false)
  expect(existsSync(join(copies, 'agent-big.jsonl'))).toBe(false)
})

test('a conversation long idle and never copied stays home until it moves again', async () => {
  const config = cfg()
  const path = writeClaude('conv-1', 'line one\n')
  const old = (now - 2 * config.activeWindowMin * 60_000) / 1000
  utimesSync(path, old, old)
  const peer = link(config)
  await sendPass(deps(config, peer))
  expect(existsSync(copyOf('conv-1'))).toBe(false)
  expect(readHeld(held)[0]?.sessions[0]?.copy).toBeNull()
  appendFileSync(path, 'line two\n')
  await sendPass(deps(config, peer))
  expect(readFileSync(copyOf('conv-1'), 'utf8')).toBe('line one\nline two\n')
})

test('Antigravity: a clean copy of its database goes whole when it changed', async () => {
  const dir = join(home, '.gemini/antigravity-cli/conversations')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'conv-9.db')
  const db = openDatabase(path, [
    "CREATE TABLE steps (text TEXT); INSERT INTO steps VALUES ('hello')",
  ])
  const config = cfg()
  const peer = link(config)
  const over = {
    sessions: () => [record({ tool: 'agy' })],
    resumeIds: () => new Map([['aaaa1111', 'conv-9']]),
  }
  await sendPass(deps(config, peer, over))
  const copy = join(
    held,
    'workstation/sessions/aaaa1111/files/.gemini/antigravity-cli/conversations/conv-9.db',
  )
  const read = (expected: number) => {
    expect(Number(readQuery(copy, 'SELECT count(*) AS n FROM steps')[0]?.n)).toBe(expected)
  }
  read(1)
  peer.calls.length = 0
  await sendPass(deps(config, peer, over))
  expect(peer.calls).toEqual([])
  db.exec("INSERT INTO steps VALUES ('more')")
  db.close()
  const later = new Date(now + 5000)
  utimesSync(path, later, later)
  await sendPass(deps(config, peer, over))
  read(2)
})

test('finding the transcript per tool', () => {
  writeClaude('conv-1', 'x\n')
  expect(transcriptFiles('claude-code', 'conv-1', now, home, now)[0]?.rel).toBe(
    '.claude/projects/-srv-workspaces-projects-aico/conv-1.jsonl',
  )
  const date = new Date(now)
  const day = join(
    home,
    '.codex/sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  )
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, 'rollout-2026-T-conv-2.jsonl'), 'x\n')
  expect(transcriptFiles('codex', 'conv-2', now, home, now)).toHaveLength(1)
  const pi = join(home, '.pi/agent/sessions/--srv--')
  mkdirSync(pi, { recursive: true })
  writeFileSync(join(pi, '2026_conv-3.jsonl'), 'x\n')
  expect(transcriptFiles('pi', 'conv-3', now, home, now)).toHaveLength(1)
  expect(transcriptFiles('aico-agent', 'x', now, home, now)).toEqual([])
  expect(transcriptFiles('claude-code', null, now, home, now)).toEqual([])
  expect(transcriptFiles('claude-code', '../evil', now, home, now)).toEqual([])
})

test('a peer can only write inside its own copy', () => {
  const options: HeldOptions = { dir: held, cfg: cfg(), now, freeBytes: () => 100 * 1024 * MB }
  const batch = (header: object, body = '') => Buffer.from(`${JSON.stringify(header)}\n${body}`)
  const file = (over: object) => ({
    session: 's1',
    rel: 'a.jsonl',
    offset: 0,
    length: 1,
    mode: 'replace',
    ...over,
  })
  expect(() => receiveBatch(batch({ from: '../x', files: [] }), options)).toThrow(/not a machine/)
  expect(() =>
    receiveBatch(batch({ from: 'm1', files: [file({ session: '../x' })] }, 'x'), options),
  ).toThrow(/not a session/)
  expect(() =>
    receiveBatch(batch({ from: 'm1', files: [file({ rel: '../../x' })] }, 'x'), options),
  ).toThrow(/not a path/)
  expect(() =>
    answerSizes({ from: 'm1', files: [{ session: 's1', rel: '/etc/passwd' }] }, options),
  ).toThrow(/not a path/)
})

test('what was said: the owner and the agent, not injected text, trimmed and masked', () => {
  const events = [
    { at: 1, role: 'user', kind: 'text', text: 'please fix   the\nthing' },
    { at: 2, role: 'assistant', kind: 'text', text: 'first answer' },
    { at: 3, role: 'user', kind: 'text', text: '<system-reminder>not the owner</system-reminder>' },
    { at: 4, role: 'user', kind: 'text', text: 'Tether resumed this session after a host reboot.' },
    { at: 5, role: 'assistant', kind: 'tool_call', text: 'rm nothing' },
    {
      at: 6,
      role: 'assistant',
      kind: 'text',
      text: `token is sk-ant-api03-${'a'.repeat(40)} and ${'long '.repeat(200)}`,
    },
  ]
  const said = saidFromEvents(events, 100)
  expect(said.owner).toEqual({ at: 1, text: 'please fix the thing' })
  expect(said.agent?.at).toBe(6)
  expect(said.agent?.text).not.toContain('a'.repeat(40))
  expect(said.agent?.text.length).toBeLessThanOrEqual(120)
})
