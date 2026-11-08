import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type AdmissionObservation,
  AgentAdmission,
  AgentAdmissionDenied,
  type AgentAdmissionLimits,
  admissionOverrideFromEnv,
  DEFAULT_AGENT_ADMISSION_LIMITS,
  type HostAdmissionVerdict,
  hostAdmissionRed,
  LAUNCH_SETTLE_MS,
  observeAgentScopes,
  parseHostAdmission,
  type ScopeFs,
} from './agent-admission'

/** host-steward's admission.json with disk red and memory green, as memctl
 * writes it (host-steward memctl), made fresh. */
function diskRed(nowMs: number): string {
  const doc = JSON.parse(
    readFileSync(new URL('../test-fixtures/host-admission-disk-red.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>
  return JSON.stringify({ ...doc, expires_at: Math.floor(nowMs / 1000) + 30 })
}

const meminfo = (gib: number) =>
  `MemTotal:       31421792 kB\nMemFree:          500000 kB\nMemAvailable:   ${Math.round(gib * 1024 * 1024)} kB\n`
const psi = (someAvg60 = 0, fullAvg60 = 0, fullAvg10 = 0) =>
  `some avg10=0.00 avg60=${someAvg60.toFixed(2)} avg300=0.00 total=12264006\n` +
  `full avg10=${fullAvg10.toFixed(2)} avg60=${fullAvg60.toFixed(2)} avg300=0.00 total=12225083\n`

interface Host {
  mem: string
  pressure: string
  scopes: Set<string> | Error
  verdict: HostAdmissionVerdict | null | Error
}

function harness(host: Partial<Host> = {}, limits: Partial<AgentAdmissionLimits> = {}) {
  const state: Host = {
    mem: meminfo(20),
    pressure: psi(),
    scopes: new Set(),
    verdict: null,
    ...host,
  }
  const records: AdmissionObservation[] = []
  let now = 1_000
  let override = false
  const admission = new AgentAdmission(
    {
      meminfo: async () => state.mem,
      memoryPressure: async () => state.pressure,
      activeAgentScopes: async () => {
        if (state.scopes instanceof Error) throw state.scopes
        return new Set(state.scopes)
      },
      hostVerdict: async () => {
        if (state.verdict instanceof Error) throw state.verdict
        return state.verdict
      },
    },
    {
      limits: () => ({ ...DEFAULT_AGENT_ADMISSION_LIMITS, ...limits }),
      override: () => override,
      now: () => now,
      record: (observation) => records.push(observation),
    },
  )
  return {
    admission,
    state,
    records,
    advance: (ms: number) => {
      now += ms
    },
    setOverride: (value: boolean) => {
      override = value
    },
  }
}

async function denial(promise: Promise<unknown>): Promise<AgentAdmissionDenied> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AgentAdmissionDenied)
    return error as AgentAdmissionDenied
  }
  throw new Error('expected admission to be deferred')
}

describe('admission override', () => {
  it('accepts only the exact override value', () => {
    expect(admissionOverrideFromEnv({})).toBe(false)
    expect(admissionOverrideFromEnv({ AICO_AGENT_ADMISSION_OVERRIDE: '1' })).toBe(true)
    expect(() => admissionOverrideFromEnv({ AICO_AGENT_ADMISSION_OVERRIDE: 'true' })).toThrow(
      AgentAdmissionDenied,
    )
  })
})

describe('AgentAdmission thresholds', () => {
  it('admits a healthy host and records numbers only', async () => {
    const { admission, records } = harness({ scopes: new Set(['a.scope']) })
    await admission.reserve({ widgetId: 'w1', kind: 'launch' })
    expect(records).toEqual([
      {
        event: 'agent_admission',
        decision: 'admitted',
        widget: 'w1',
        kind: 'launch',
        memAvailableGiB: 20,
        psiSomeAvg60: 0,
        psiFullAvg60: 0,
        psiFullAvg10: 0,
        activeAgents: 1,
        ceiling: null,
        reason: null,
      },
    ])
  })

  it('does not cap healthy concurrency by default', async () => {
    const scopes = new Set(Array.from({ length: 40 }, (_, i) => `agent-${i}.scope`))
    const { admission } = harness({ scopes })
    await expect(admission.reserve({ widgetId: 'w', kind: 'launch' })).resolves.toBeDefined()
  })

  it.each([
    ['MemAvailable just below 6 GiB', { mem: meminfo(5.99) }, /available memory/],
    ['some avg60 at 10', { pressure: psi(10, 0, 0) }, /some avg60/],
    ['full avg60 at 2', { pressure: psi(0, 2, 0) }, /full avg60/],
    ['full avg10 at 5', { pressure: psi(0, 0, 5) }, /full avg10/],
  ])('defers at the boundary: %s', async (_label, host, reason) => {
    const { admission, records } = harness(host)
    const denied = await denial(admission.reserve({ widgetId: 'w', kind: 'launch' }))
    expect(denied.retryable).toBe(true)
    expect(denied.reason).toMatch(reason)
    expect(denied.message).toMatch(/Nothing was started; retry/)
    expect(records.at(-1)?.decision).toBe('deferred')
    expect(admission.inFlight).toBe(0)
  })

  it.each([
    ['MemAvailable exactly 6 GiB', { mem: meminfo(6) }],
    ['PSI just under every threshold', { pressure: psi(9.99, 1.99, 4.99) }],
  ])('admits just inside the boundary: %s', async (_label, host) => {
    const { admission } = harness(host)
    await expect(admission.reserve({ widgetId: 'w', kind: 'launch' })).resolves.toBeDefined()
  })

  it('fails closed with a visible reason on malformed host data', async () => {
    const { admission, records } = harness({ pressure: 'garbage' })
    const denied = await denial(admission.reserve({ widgetId: 'w', kind: 'launch' }))
    expect(denied.reason).toMatch(/pressure\/memory/)
    expect(records.at(-1)).toMatchObject({ decision: 'deferred', psiSomeAvg60: null })
  })

  it('treats a scope-count failure as telemetry only when no ceiling is set', async () => {
    const { admission, records } = harness({ scopes: new Error('EACCES') })
    await admission.reserve({ widgetId: 'w', kind: 'launch' })
    expect(records.at(-1)).toMatchObject({ decision: 'admitted', activeAgents: null })
  })

  it('fails closed on a scope-count failure when a ceiling is set', async () => {
    const { admission } = harness({ scopes: new Error('EACCES') }, { maxActiveAgents: 10 })
    const denied = await denial(admission.reserve({ widgetId: 'w', kind: 'launch' }))
    expect(denied.reason).toMatch(/active agent scopes/)
  })

  it('lets the operator override bypass pressure but still records it', async () => {
    const h = harness({ pressure: psi(50, 50, 50) })
    h.setOverride(true)
    await h.admission.reserve({ widgetId: 'w', kind: 'launch' })
    expect(h.records.at(-1)).toMatchObject({ decision: 'override', psiFullAvg10: 50 })
  })
})

describe('AgentAdmission optional ceiling', () => {
  it('serializes concurrent starts so only one takes the final slot', async () => {
    const { admission } = harness({ scopes: new Set(['a.scope']) }, { maxActiveAgents: 2 })
    const results = await Promise.allSettled([
      admission.reserve({ widgetId: 'w1', kind: 'launch' }),
      admission.reserve({ widgetId: 'w2', kind: 'launch' }),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('frees the slot immediately when a launch fails', async () => {
    const { admission } = harness({}, { maxActiveAgents: 1 })
    const ticket = await admission.reserve({ widgetId: 'w1', kind: 'launch' })
    await denial(admission.reserve({ widgetId: 'w2', kind: 'launch' }))
    ticket.release()
    ticket.release()
    expect(admission.inFlight).toBe(0)
    await expect(admission.reserve({ widgetId: 'w2', kind: 'launch' })).resolves.toBeDefined()
  })

  it('holds a committed slot until its agent is observed, without double counting', async () => {
    const h = harness({}, { maxActiveAgents: 2 })
    const ticket = await h.admission.reserve({ widgetId: 'w1', kind: 'launch' })
    ticket.commit('new.scope')
    ticket.release() // a committed launch is not released by the finally path
    expect(h.admission.inFlight).toBe(1)
    h.state.scopes = new Set(['new.scope'])
    await h.admission.reserve({ widgetId: 'w2', kind: 'launch' })
    expect(h.records.at(-1)?.activeAgents).toBe(1)
  })

  it('drops a committed slot after the settle window if no agent appears', async () => {
    const h = harness({}, { maxActiveAgents: 1 })
    const ticket = await h.admission.reserve({ widgetId: 'w1', kind: 'launch' })
    ticket.commit('quiet.scope')
    await denial(h.admission.reserve({ widgetId: 'w2', kind: 'launch' }))
    h.advance(LAUNCH_SETTLE_MS)
    await expect(h.admission.reserve({ widgetId: 'w2', kind: 'launch' })).resolves.toBeDefined()
  })

  it('admits a replacement at the ceiling by excluding the scope it replaces', async () => {
    const { admission } = harness(
      { scopes: new Set(['old.scope', 'b.scope']) },
      { maxActiveAgents: 2 },
    )
    await denial(admission.reserve({ widgetId: 'w3', kind: 'launch' }))
    await expect(
      admission.reserve({ widgetId: 'w1', kind: 'replacement', replacingScope: 'old.scope' }),
    ).resolves.toBeDefined()
  })

  it('still applies pressure to a replacement at the ceiling', async () => {
    const { admission } = harness(
      { scopes: new Set(['old.scope']), pressure: psi(0, 0, 9) },
      { maxActiveAgents: 1 },
    )
    const denied = await denial(
      admission.reserve({ widgetId: 'w1', kind: 'replacement', replacingScope: 'old.scope' }),
    )
    expect(denied.reason).toMatch(/full avg10/)
  })
})

describe('observeAgentScopes', () => {
  const APP = '/cg/app.slice'
  function fakeFs(tree: Record<string, string[]>, files: Record<string, string>): ScopeFs {
    const missing = (path: string) => Object.assign(new Error(path), { code: 'ENOENT' })
    return {
      listDirectories: async (path) => {
        if (!(path in tree)) throw missing(path)
        return tree[path]
      },
      readFile: async (path) => {
        if (!(path in files)) throw missing(path)
        return files[path]
      },
    }
  }
  const options = (fs: ScopeFs) => ({
    fs,
    appSliceDir: APP,
    isPaneScope: (unit: string) => unit.startsWith('tmux-spawn-'),
    agentProcessNames: new Set(['codex', 'claude']),
  })

  it('counts only pane scopes containing an agent process, including nested cgroups', async () => {
    const fs = fakeFs(
      {
        [APP]: [
          'tmux-spawn-a.scope',
          'tmux-spawn-shell.scope',
          'tmux-spawn-gone.scope',
          'chrome.scope',
          'tmux-spawn-nested.scope',
        ],
        [`${APP}/tmux-spawn-a.scope`]: [],
        [`${APP}/tmux-spawn-shell.scope`]: [],
        [`${APP}/tmux-spawn-nested.scope`]: ['child.d'],
        [`${APP}/tmux-spawn-nested.scope/child.d`]: [],
      },
      {
        [`${APP}/tmux-spawn-a.scope/cgroup.procs`]: '10\n11\n',
        '/proc/10/comm': 'bash\n',
        '/proc/11/comm': 'codex\n',
        [`${APP}/tmux-spawn-shell.scope/cgroup.procs`]: '20\n',
        '/proc/20/comm': 'bash\n',
        [`${APP}/tmux-spawn-nested.scope/cgroup.procs`]: '30\n',
        '/proc/30/comm': 'bash\n',
        [`${APP}/tmux-spawn-nested.scope/child.d/cgroup.procs`]: '31\n32\n',
        '/proc/32/comm': 'claude\n',
      },
    )
    expect(await observeAgentScopes(options(fs))).toEqual(
      new Set(['tmux-spawn-a.scope', 'tmux-spawn-nested.scope']),
    )
  })

  it('counts Pi while it still runs as node, before it names itself', async () => {
    const fs = fakeFs(
      { [APP]: ['tmux-spawn-pi.scope'], [`${APP}/tmux-spawn-pi.scope`]: [] },
      {
        [`${APP}/tmux-spawn-pi.scope/cgroup.procs`]: '40\n41\n',
        '/proc/40/comm': 'bash\n',
        '/proc/40/cmdline': 'bash\0',
        '/proc/41/comm': 'node\n',
        '/proc/41/cmdline': 'node\0/opt/pi/node_modules/.bin/pi\0--approve\0',
      },
    )
    expect(
      await observeAgentScopes({ ...options(fs), agentProcessNames: new Set(['pi']) }),
    ).toEqual(new Set(['tmux-spawn-pi.scope']))
  })

  it('fails closed on malformed cgroup.procs', async () => {
    const fs = fakeFs(
      { [APP]: ['tmux-spawn-a.scope'], [`${APP}/tmux-spawn-a.scope`]: [] },
      { [`${APP}/tmux-spawn-a.scope/cgroup.procs`]: 'abc\n' },
    )
    await expect(observeAgentScopes(options(fs))).rejects.toThrow(/cgroup.procs/)
  })

  it('fails closed when app.slice is unreadable', async () => {
    await expect(observeAgentScopes(options(fakeFs({}, {})))).rejects.toThrow()
  })
})

describe('Host admission state', () => {
  const now = 1_791_819_000_000

  it('defers every launch while the host denies admission, with its reason', async () => {
    const {
      admission,
      state: host,
      records,
    } = harness({
      verdict: { admit: false, state: 'red', reason: 'swap 80%' },
    })
    const denied = await denial(admission.reserve({ widgetId: 'abcd1234', kind: 'launch' }))
    expect(denied.reason).toBe('The host has closed agent admission (swap 80%).')
    expect(records.at(-1)).toMatchObject({ decision: 'deferred' })
    host.verdict = null
    await expect(admission.reserve({ widgetId: 'abcd1234', kind: 'launch' })).resolves.toBeTruthy()
  })

  it("leaves an amber launch to Tether's own thresholds", async () => {
    const amber = { admit: false, state: 'amber' as const, reason: 'Memory is tight: 8.0 GiB' }
    // 8 GiB available, no stalls: an agent launch still fits.
    const healthy = harness({ mem: meminfo(8), verdict: amber })
    await expect(
      healthy.admission.reserve({ widgetId: 'abcd1234', kind: 'launch' }),
    ).resolves.toBeTruthy()
    const low = harness({ mem: meminfo(4), verdict: amber })
    expect(
      (await denial(low.admission.reserve({ widgetId: 'abcd1234', kind: 'launch' }))).reason,
    ).toContain('available memory')
    const stalled = harness({ mem: meminfo(8), pressure: psi(0, 0, 5), verdict: amber })
    expect(
      (await denial(stalled.admission.reserve({ widgetId: 'abcd1234', kind: 'launch' }))).reason,
    ).toContain('full avg10')
  })

  it("lets a fresh host admit replace Tether's own thresholds", async () => {
    const { admission } = harness({
      mem: meminfo(2),
      pressure: psi(50, 3, 6),
      verdict: { admit: true, state: 'green', reason: 'green' },
    })
    await expect(admission.reserve({ widgetId: 'abcd1234', kind: 'launch' })).resolves.toBeTruthy()
  })

  it('falls back to its own thresholds without a verdict or when the read fails', async () => {
    for (const verdict of [null, new Error('EACCES')]) {
      const { admission } = harness({ pressure: psi(0, 0, 5), verdict })
      const denied = await denial(admission.reserve({ widgetId: 'abcd1234', kind: 'launch' }))
      expect(denied.reason).toContain('full avg10')
    }
  })

  it('a red disk closes agent launches and wait cmd starts', async () => {
    const verdict = parseHostAdmission(diskRed(now), now)
    expect(verdict).toMatchObject({ admit: false, state: 'red', memoryState: 'green' })
    // daemon.ts wires wait cmd's admissionRed() to hostAdmissionRed(admission path)
    const dir = mkdtempSync(join(tmpdir(), 'tether-admission-'))
    const file = join(dir, 'admission.json')
    writeFileSync(file, diskRed(now))
    expect(hostAdmissionRed(file, now)).toBe(true)
    expect(hostAdmissionRed(file, now + 3_600_000)).toBe(false) // stale: no verdict
    expect(hostAdmissionRed(join(dir, 'missing.json'), now)).toBe(false)
    expect(hostAdmissionRed(null, now)).toBe(false)
    const { admission } = harness({ verdict })
    const denied = await denial(admission.reserve({ widgetId: 'abcd1234', kind: 'launch' }))
    expect(denied.reason).toContain('The host has closed agent admission (Disk is critical')
  })
})
