import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PullKind } from './wait-kinds'
import { PullReaders, parseJobResult } from './wait-readers'

const JOB = '0123456789abcdef0123456789abcdef'
const TAP = 'fedcba9876543210fedcba9876543210'

let dir: string
let pokes: string[]
let probes: string[]
let probeAnswer: string | null
let red: boolean
let clock: number

function readers(): PullReaders {
  return new PullReaders({
    paths: {
      jobsDir: join(dir, 'jobs'),
      ledger: join(dir, 'leases', '_coord.json'),
      tapDirs: [join(dir, 'out'), join(dir, 'agent')],
    },
    run: (id) =>
      id === 'run-1'
        ? { state: 'needs_owner', launcherId: 'aaaa0001' }
        : id === 'run-2'
          ? { state: null, launcherId: null }
          : undefined,
    ask: (id) => (id === 'c'.repeat(12) ? { state: 'answered' } : undefined),
    host: (name) => (name === 'gem' ? 'connected' : null),
    admissionRed: () => red,
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
  for (const sub of ['jobs', 'leases', 'out', 'agent']) mkdirSync(join(dir, sub))
  pokes = []
  probes = []
  probeAnswer = null
  red = false
  clock = 1_000_000
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

  it('reads a reply from the ledger: typed fields only, withdrawn is closed', () => {
    const r = readers()
    writeFileSync(
      join(dir, 'leases', '_coord.json'),
      JSON.stringify({
        messages: [
          { id: 'abc123', to: 'cc:1c7a9f', state: 'acked', intent: 'yes', text: 'secret' },
          { id: 'def456', to: 'cc:1', state: 'open', withdrawn: true },
        ],
      }),
    )
    expect(r.pullRef('reply', 'abc123')).toBe('abc123')
    expect(r.pullRef('reply', '999999')).toBeNull()
    expect(r.read('reply', 'abc123')).toEqual({
      state: 'acked',
      detail: 'yes',
      title: 'cc:1c7a9f',
    })
    expect(r.read('reply', 'def456')).toEqual({ state: 'closed', detail: null, title: 'cc:1' })
    expect(r.read('reply', '999999')).toBeNull()
  })

  it('reads a tap from either answer dir; unanswered is unknown, never gone', () => {
    const r = readers()
    expect(r.pullRef('tap', TAP)).toBe(TAP)
    expect(r.read('tap', TAP)).toBeUndefined()
    writeFileSync(join(dir, 'agent', `${TAP}.resp.json`), JSON.stringify({ outcome: 'denied' }))
    expect(r.read('tap', TAP)).toEqual({ state: 'denied', detail: null, title: null })
  })

  it('reads runs, asks and hosts from Tether', () => {
    const r = readers()
    expect(r.read('run', 'run-1')?.state).toBe('needs_owner')
    expect(r.read('run', 'run-2')).toBeNull()
    expect(r.pullRef('run', 'run-3')).toBeNull()
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
      writeFileSync(join(dir, 'leases', '_coord.json'), '{"messages": []}')
      writeFileSync(join(dir, 'out', `${TAP}.resp.json`), '{"outcome": "applied"}')
      for (let i = 0; i < 50 && pokes.length < 3; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 20))
      expect(pokes).toEqual(expect.arrayContaining([`job:${JOB}`, 'reply:*', `tap:${TAP}`]))
    } finally {
      r.stop()
    }
  })

  it('parses the owner CLI result', () => {
    expect(parseJobResult('{"state": "failed", "exit_code": 1}')).toEqual({
      state: 'failed',
      exit: '1',
    })
    expect(parseJobResult('JOB:x|aico|failed')).toBeNull()
  })
})
