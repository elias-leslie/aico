import { describe, expect, it } from 'vitest'
import {
  type AdmissionObservation,
  AgentAdmission,
  AgentAdmissionDenied,
  type AgentAdmissionLimits,
  admissionLimitsFromEnv,
  admissionOverrideFromEnv,
  DEFAULT_AGENT_ADMISSION_LIMITS,
  LAUNCH_SETTLE_MS,
  observeAgentScopes,
  parseMemAvailable,
  parseMemoryPressure,
  type ScopeFs,
} from './agent-admission'

const GiB = 1024 ** 3
const meminfo = (gib: number) =>
  `MemTotal:       31421792 kB\nMemFree:          500000 kB\nMemAvailable:   ${Math.round(gib * 1024 * 1024)} kB\n`
const psi = (someAvg60 = 0, fullAvg60 = 0, fullAvg10 = 0) =>
  `some avg10=0.00 avg60=${someAvg60.toFixed(2)} avg300=0.00 total=12264006\n` +
  `full avg10=${fullAvg10.toFixed(2)} avg60=${fullAvg60.toFixed(2)} avg300=0.00 total=12225083\n`

interface Host {
  mem: string
  pressure: string
  scopes: Set<string> | Error
}

function harness(host: Partial<Host> = {}, limits: Partial<AgentAdmissionLimits> = {}) {
  const state: Host = { mem: meminfo(20), pressure: psi(), scopes: new Set(), ...host }
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

describe('parseMemAvailable', () => {
  it('reads kB as bytes', () => {
    expect(parseMemAvailable(meminfo(6))).toBe(6 * GiB)
  })

  it.each([
    ['missing', 'MemTotal: 1 kB\n'],
    ['duplicated', 'MemAvailable: 1 kB\nMemAvailable: 2 kB\n'],
    ['wrong unit', 'MemAvailable: 1 MB\n'],
    ['negative', 'MemAvailable: -1 kB\n'],
    ['fractional', 'MemAvailable: 1.5 kB\n'],
    ['empty', ''],
  ])('fails closed when %s', (_label, text) => {
    expect(() => parseMemAvailable(text)).toThrow(AgentAdmissionDenied)
  })
})

describe('parseMemoryPressure', () => {
  it('reads the kernel format', () => {
    expect(parseMemoryPressure(psi(10.5, 2.25, 5))).toEqual({
      someAvg60: 10.5,
      fullAvg60: 2.25,
      fullAvg10: 5,
    })
  })

  it.each([
    ['empty', ''],
    ['missing full', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n'],
    ['duplicate some', `${psi()}some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`],
    [
      'non-numeric',
      'some avg10=x avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n',
    ],
    [
      'over 100',
      'some avg10=0.00 avg60=100.01 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n',
    ],
    [
      'extra field',
      'some avg10=0.00 avg60=0.00 avg300=0.00 total=1 x=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n',
    ],
    ['blank line', `${psi()}\n`],
  ])('fails closed when %s', (_label, text) => {
    expect(() => parseMemoryPressure(text)).toThrow(AgentAdmissionDenied)
  })
})

describe('admission configuration', () => {
  it('is pressure-only by default with no static ceiling', () => {
    expect(admissionLimitsFromEnv({})).toEqual(DEFAULT_AGENT_ADMISSION_LIMITS)
    expect(DEFAULT_AGENT_ADMISSION_LIMITS.maxActiveAgents).toBeNull()
  })

  it('parses documented overrides', () => {
    expect(
      admissionLimitsFromEnv({
        AICO_AGENT_MAX_ACTIVE: '24',
        AICO_AGENT_MIN_AVAILABLE_GIB: '4',
        AICO_AGENT_MAX_PSI_SOME_AVG60: '15.5',
        AICO_AGENT_MAX_PSI_FULL_AVG60: '3',
        AICO_AGENT_MAX_PSI_FULL_AVG10: '7',
      }),
    ).toEqual({
      maxActiveAgents: 24,
      minAvailableBytes: 4 * GiB,
      maxSomeAvg60: 15.5,
      maxFullAvg60: 3,
      maxFullAvg10: 7,
    })
  })

  it.each([
    ['AICO_AGENT_MAX_ACTIVE', '0'],
    ['AICO_AGENT_MAX_ACTIVE', '6.5'],
    ['AICO_AGENT_MIN_AVAILABLE_GIB', '-1'],
    ['AICO_AGENT_MAX_PSI_SOME_AVG60', 'high'],
    ['AICO_AGENT_MAX_PSI_FULL_AVG10', '101'],
  ])('rejects malformed %s=%s', (name, value) => {
    expect(() => admissionLimitsFromEnv({ [name]: value })).toThrow(AgentAdmissionDenied)
  })

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
