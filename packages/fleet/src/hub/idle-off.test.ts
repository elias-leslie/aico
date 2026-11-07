import { describe, expect, it } from 'vitest'
import type { IdleFacts } from './hub'
import { IdleOff, type IdleOffRow } from './idle-off'

const MIN = 60_000

function setup(facts: Partial<IdleFacts> = {}, entry: Partial<IdleFacts['entry']> = {}) {
  const state = {
    now: 1_000_000,
    facts: {
      entry: { name: 'vm', sleep: ['st', 'vm', 'shutdown', '201'], idleOffMin: 15, ...entry },
      live: true,
      sessions: 0,
      wakes: 0,
      busy: false,
      ...facts,
    } as IdleFacts,
    booked: false,
    off: [] as string[],
    rows: [] as (IdleOffRow | null)[],
    logs: [] as string[],
    fail: null as string | null,
  }
  const idle = new IdleOff({
    hostNames: () => ['vm'],
    idleFacts: () => state.facts,
    booked: () => state.booked,
    powerOff: async (host) => {
      if (state.fail) throw new Error(state.fail)
      state.off.push(host)
    },
    status: async (_host, row) => {
      state.rows.push(row)
    },
    log: (message) => state.logs.push(message),
    now: () => state.now,
  })
  const wait = async (minutes: number) => {
    state.now += minutes * MIN
    await idle.tick()
  }
  return { state, idle, wait }
}

describe('idle power-off', () => {
  it('powers a host off after its idle minutes and writes a Status row', async () => {
    const { state, idle, wait } = setup()
    await idle.tick()
    await wait(14)
    expect(state.off).toEqual([])
    await wait(1)
    expect(state.off).toEqual(['vm'])
    expect(state.logs.join('\n')).toContain('vm: powered off after 15 minutes with no sessions')
    const row = state.rows.at(-1)
    expect(row).toMatchObject({ id: 'tether/idle-off/vm', kind: 'vm', state: 'off', machine: 'vm' })
    expect(row?.meaning).toContain('15 minutes with no sessions')
  })

  it('uses the host entry minutes and 0 keeps the host on', async () => {
    const short = setup({}, { idleOffMin: 2 })
    await short.idle.tick()
    await short.wait(2)
    expect(short.state.off).toEqual(['vm'])
    const never = setup({}, { idleOffMin: 0 })
    await never.idle.tick()
    await never.wait(600)
    expect(never.state.off).toEqual([])
  })

  it('leaves a host without a sleep command, a link that is down, and a busy host', async () => {
    const noSleep = setup({}, { sleep: null })
    await noSleep.idle.tick()
    await noSleep.wait(60)
    const down = setup({ live: false })
    await down.idle.tick()
    await down.wait(60)
    expect(noSleep.state.off).toEqual([])
    expect(down.state.off).toEqual([])
    for (const busy of [{ sessions: 1 }, { wakes: 1 }, { busy: true }]) {
      const run = setup(busy)
      await run.idle.tick()
      await run.wait(60)
      expect(run.state.off).toEqual([])
    }
    const booked = setup()
    booked.state.booked = true
    await booked.idle.tick()
    await booked.wait(60)
    expect(booked.state.off).toEqual([])
  })

  it('starts the idle time over whenever the host is busy', async () => {
    const { state, idle, wait } = setup()
    await idle.tick()
    await wait(14)
    state.facts.sessions = 1
    await wait(1)
    state.facts.sessions = 0
    await wait(0)
    await wait(14)
    expect(state.off).toEqual([])
    await wait(1)
    expect(state.off).toEqual(['vm'])
  })

  it('logs a refused power-off and tries again after another idle period', async () => {
    const { state, idle, wait } = setup()
    state.fail = '1 session running on vm'
    await idle.tick()
    await wait(15)
    expect(state.off).toEqual([])
    expect(state.logs.join('\n')).toContain('idle power-off did not happen: 1 session running')
    state.fail = null
    await wait(14)
    expect(state.off).toEqual([])
    await wait(1)
    expect(state.off).toEqual(['vm'])
  })

  it('clears its Status row once the host is up again, once', async () => {
    const { state, idle, wait } = setup()
    await idle.tick()
    expect(state.rows).toEqual([null])
    await wait(15)
    state.facts.live = false
    await wait(5)
    state.facts.live = true
    state.facts.sessions = 1
    await wait(1)
    await wait(1)
    expect(state.rows.filter((row) => row === null)).toHaveLength(2)
  })
})
