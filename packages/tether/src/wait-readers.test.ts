import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PullKind } from './wait-kinds'
import {
  anchorWidget,
  type CmdSpec,
  type CmdUnits,
  cmdResult,
  PullReaders,
  parseJobResult,
  systemdCmdUnits,
} from './wait-readers'

const JOB = '0123456789abcdef0123456789abcdef'

it.each([
  ['success', '0', 'succeeded'],
  ['exit-code', '3', 'failed'],
])(
  'records the watcher outcome through the actual stop shell (%s)',
  async (result, status, state) => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'systemd-run'),
      `#!/bin/sh
for arg do
  case "$arg" in ExecStopPost=*) /bin/sh -c "\${arg#ExecStopPost=}";; esac
done
`,
      { mode: 0o755 },
    )
    const units = systemdCmdUnits({
      PATH: `${bin}:/usr/bin:/bin`,
      SERVICE_RESULT: result,
      EXIT_CODE: 'exited',
      EXIT_STATUS: status,
    })
    const path = join(dir, 'result')
    expect(
      await units.start(
        '111111111111',
        {
          argv: ['/bin/true'],
          cwd: dir,
          deadline: Date.now() + 10_000,
        },
        path,
        10,
      ),
    ).toBe('started')
    expect(cmdResult(readFileSync(path, 'utf8'))).toEqual({ state, detail: `exit-${status}` })
  },
)

it('finds the user bus for a wait launched without desktop environment', async () => {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'systemd-run'),
    '#!/bin/sh\n[ "$XDG_RUNTIME_DIR" = "/run/user/' +
      (process.getuid?.() ?? 0) +
      '" ] && [ "$DBUS_SESSION_BUS_ADDRESS" = "unix:path=$XDG_RUNTIME_DIR/bus" ]\n',
    { mode: 0o755 },
  )
  const units = systemdCmdUnits({ PATH: bin })
  expect(
    await units.start(
      '111111111111',
      { argv: ['/bin/true'], cwd: dir, deadline: Date.now() + 10_000 },
      join(dir, 'result'),
      10,
    ),
  ).toBe('started')
})

let dir: string
let pokes: string[]
let probes: string[]
let probeAnswer: string | null
let red: boolean
let clock: number
let started: { ref: string; spec: CmdSpec; result: string; runtime: number }[]
let ledger: { version: number; doc: Record<string, unknown> }
let stopped: string[]
let startAnswer: 'started' | 'exists' | 'failed'
const units: CmdUnits = {
  start: async (ref, spec, result, runtime) => {
    started.push({ ref, spec, result, runtime })
    return startAnswer
  },
  stop: async (ref) => {
    stopped.push(ref)
  },
}

function readers(): PullReaders {
  return new PullReaders({
    ledgerDoc: () => ledger,
    paths: {
      jobsDir: join(dir, 'jobs'),
      cmdDir: join(dir, 'cmd'),
    },
    ask: (id) =>
      id === 'c'.repeat(12) ? { state: 'answered', question: 'Rebuild aico now?' } : undefined,
    agentTitle: (anchor) => (anchor === '4242:99' ? 'SummitFlow — One wake per message' : null),
    host: (name) => (name === 'gem' ? 'connected' : null),
    admissionRed: () => red,
    cmdUnits: units,
    probeJob: async (id) => {
      probes.push(id)
      return probeAnswer
    },
    poke: (kind: PullKind, ref?: string) => pokes.push(`${kind}:${ref ?? '*'}`),
    now: () => clock,
    log: () => {},
  })
}

const job = (state: string, extra: Record<string, unknown> = {}) =>
  writeFileSync(
    join(dir, 'jobs', `${JOB}.json`),
    JSON.stringify({ job_id: JOB, project: 'aico', state, ...extra }),
  )

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tether-wait-readers-'))
  mkdirSync(join(dir, 'jobs'))
  ledger = { version: 0, doc: {} }
  pokes = []
  probes = []
  probeAnswer = null
  red = false
  clock = 1_000_000
  started = []
  stopped = []
  startAnswer = 'started'
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('PullReaders', () => {
  it('reads a job file and makes a unique prefix whole', () => {
    const r = readers()
    job('running')
    expect(r.pullRef('job', JOB.slice(0, 8))).toBe(JOB)
    expect(r.pullRef('job', 'ffffffff')).toBeNull()
    expect(r.read('job', JOB)).toEqual({ state: 'running', detail: null, title: 'aico' })
    job('failed', { exit_code: 3 })
    expect(r.read('job', JOB)).toEqual({ state: 'failed', detail: '3', title: 'aico' })
    expect(r.read('job', 'f'.repeat(32))).toBeNull()
  })

  it('probes a job its file says is going, throttled, never on red admission', async () => {
    const r = readers()
    job('running')
    probeAnswer = JSON.stringify({ state: 'interrupted', exit_code: null })
    red = true
    r.refresh('job', JOB, false)
    expect(probes).toEqual([])
    red = false
    r.refresh('job', JOB, false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(probes).toEqual([JOB])
    expect(pokes).toContain(`job:${JOB}`)
    expect(r.read('job', JOB)?.state).toBe('interrupted')
    // A finished file needs no probe.
    job('succeeded', { exit_code: 0 })
    r.refresh('job', JOB, true)
    expect(probes).toHaveLength(1)
    expect(r.read('job', JOB)?.state).toBe('succeeded')
  })

  it('throttles the 60 s probe; a nudge forces it', async () => {
    const r = readers()
    job('running')
    probeAnswer = JSON.stringify({ state: 'running' })
    r.refresh('job', JOB, false)
    await new Promise((resolve) => setImmediate(resolve))
    r.refresh('job', JOB, false)
    expect(probes).toHaveLength(1)
    r.refresh('job', JOB, true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(probes).toHaveLength(2)
  })

  it("reads a reply from the ledger: the answer's note but not the request's text, withdrawn is closed", () => {
    const r = readers()
    ledger = {
      version: ledger.version + 1,
      doc: {
        messages: [
          {
            id: 'abc123',
            to: 'cc:1c7a9f',
            state: 'acked',
            intent: 'yes',
            note: 'done',
            text: 'secret',
          },
          { id: 'def456', to: 'cc:1', state: 'open', withdrawn: true },
        ],
      },
    }
    expect(r.pullRef('reply', 'abc123')).toBe('abc123')
    expect(r.pullRef('reply', '999999')).toBeNull()
    expect(r.read('reply', 'abc123')).toEqual({
      state: 'acked',
      detail: 'yes',
      title: 'cc:1c7a9f',
      note: 'done',
    })
    expect(r.read('reply', 'def456')).toEqual({ state: 'closed', detail: null, title: 'cc:1' })
    expect(r.read('reply', '999999')).toBeNull()
  })

  it("names a reply's recipient by its window title when its anchor is in Aico", () => {
    const r = readers()
    ledger = {
      version: ledger.version + 1,
      doc: {
        messages: [
          { id: 'abc123', to: 'cc:94bdf3', state: 'acked', intent: 'yes' },
          { id: 'def456', to: 'cc:gone01', state: 'open' },
        ],
        identities: { 'cc:94bdf3': { anchor: '4242:99' }, 'cc:gone01': { anchor: '1:1' } },
      },
    }
    expect(r.read('reply', 'abc123')).toMatchObject({
      title: 'SummitFlow — One wake per message (cc:94bdf3)',
    })
    expect(r.read('reply', 'def456')).toMatchObject({ title: 'cc:gone01' })
  })

  it('an ask reads its question as its title', () => {
    expect(readers().read('ask', 'c'.repeat(12))).toEqual({
      state: 'answered',
      detail: null,
      title: 'Rebuild aico now?',
    })
  })

  it("an anchor names the Aico session of the live process it started, never a reused pid's", () => {
    const stat = `4242 (claude) S ${'1 '.repeat(18)}99 0 0`
    const files: Record<string, string> = {
      '/proc/4242/stat': stat,
      '/proc/4242/environ': 'HOME=/h\0AICO_WIDGET_ID=644e1b6c\0',
    }
    const fs = {
      readFile: (path: string) => {
        if (!(path in files)) throw new Error('ENOENT')
        return files[path] as string
      },
    }
    expect(anchorWidget(fs, '4242:99')).toBe('644e1b6c')
    expect(anchorWidget(fs, '4242:98')).toBeNull()
    expect(anchorWidget(fs, '5151:1')).toBeNull()
    expect(anchorWidget(fs, 'bad')).toBeNull()
  })

  it('reads asks and hosts from Tether', () => {
    const r = readers()
    expect(r.read('ask', 'c'.repeat(12))?.state).toBe('answered')
    expect(r.read('ask', 'd'.repeat(12))).toBeNull()
    expect(r.read('host', 'gem')?.state).toBe('connected')
    expect(r.pullRef('host', 'nowhere')).toBeNull()
  })

  it('watches the owners’ files and pokes the kind', async () => {
    const r = readers()
    r.watch()
    try {
      job('running')
      await vi.waitFor(() => expect(pokes.length).toBeGreaterThan(0))
      expect(pokes).toEqual(expect.arrayContaining([`job:${JOB}`]))
    } finally {
      r.stop()
    }
  })

  it('starts a cmd watcher once, never on red admission, and reads how it ended', async () => {
    const r = readers()
    const REF = 'abcdef012345'
    red = true
    r.createCmd(REF, { argv: ['sleep', '20'], cwd: '/srv/x', deadline: clock + 600_000 })
    expect(started).toEqual([])
    expect(r.read('cmd', REF)).toEqual({ state: 'waiting', detail: null, title: 'sleep 20' })
    expect(r.pullRef('cmd', REF)).toBe(REF)
    expect(r.cmdArgv(REF)).toEqual(['sleep', '20'])
    red = false
    r.refresh('cmd', REF, false)
    r.refresh('cmd', REF, false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      ref: REF,
      result: join(dir, 'cmd', `${REF}.result`),
      runtime: 660,
    })
    expect(pokes).toContain(`cmd:${REF}`)
    expect(r.read('cmd', REF)?.state).toBe('running')
    r.refresh('cmd', REF, true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(started).toHaveLength(1)
    writeFileSync(join(dir, 'cmd', `${REF}.result`), 'exit-code exited 1\n')
    expect(r.read('cmd', REF)).toEqual({ state: 'failed', detail: 'exit-1', title: 'sleep 20' })
    r.endCmd(REF)
    expect(stopped).toEqual([])
    expect(r.read('cmd', REF)).toBeNull()
    expect(r.pullRef('cmd', REF)).toBeNull()
  })

  it('a watcher that cannot start is failed; one still running is stopped when let go', async () => {
    const r = readers()
    startAnswer = 'failed'
    r.createCmd('111111111111', { argv: ['x'], cwd: '/', deadline: clock + 60_000 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(r.read('cmd', '111111111111')).toMatchObject({ state: 'failed', detail: 'start-failed' })
    // A start that failed (or timed out) may have left a unit: stopped anyway.
    expect(stopped).toEqual(['111111111111'])
    stopped = []
    startAnswer = 'started'
    r.createCmd('222222222222', { argv: ['y'], cwd: '/', deadline: clock + 60_000 })
    await new Promise((resolve) => setImmediate(resolve))
    r.sweepCmd(new Set(['111111111111']))
    await new Promise((resolve) => setImmediate(resolve))
    expect(stopped).toEqual(['222222222222'])
    expect(r.read('cmd', '222222222222')).toBeNull()
    expect(r.read('cmd', '111111111111')?.state).toBe('failed')
  })

  it('a wait that ends while its unit starts stops it once the start returns; nothing past the deadline starts', async () => {
    const r = readers()
    const REF = '333333333333'
    r.createCmd(REF, { argv: ['sleep', '9'], cwd: '/', deadline: clock + 60_000 })
    r.endCmd(REF)
    expect(stopped).toEqual([])
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(stopped).toEqual([REF])
    expect(r.read('cmd', REF)).toBeNull()
    expect(readdirSync(join(dir, 'cmd')).filter((name) => name.startsWith(REF))).toEqual([])
    started = []
    r.createCmd('444444444444', { argv: ['x'], cwd: '/', deadline: clock - 1 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(started).toEqual([])
    // A late result from a slow stop, its record already gone, is swept.
    writeFileSync(join(dir, 'cmd', '555555555555.result'), 'success exited 0\n')
    r.sweepCmd(new Set(['444444444444']))
    expect(readdirSync(join(dir, 'cmd'))).toEqual(['444444444444.json'])
  })

  it('reads systemd result words as typed details', () => {
    expect(cmdResult('success exited 0')).toEqual({ state: 'succeeded', detail: 'exit-0' })
    expect(cmdResult('exit-code exited 3')).toEqual({ state: 'failed', detail: 'exit-3' })
    expect(cmdResult('signal killed TERM')).toEqual({ state: 'failed', detail: 'signal-TERM' })
    expect(cmdResult('timeout killed TERM')).toEqual({ state: 'failed', detail: 'timeout' })
    expect(cmdResult('oom-kill killed KILL')).toEqual({ state: 'failed', detail: 'oom-kill' })
    expect(cmdResult('start-failed')).toEqual({ state: 'failed', detail: 'start-failed' })
    expect(cmdResult('')).toEqual({ state: 'failed', detail: 'failed' })
  })

  it('parses the owner CLI result', () => {
    expect(parseJobResult('{"state": "failed", "exit_code": 1}')).toEqual({
      state: 'failed',
      exit: '1',
    })
    expect(parseJobResult('JOB:x|aico|failed')).toBeNull()
  })
})
