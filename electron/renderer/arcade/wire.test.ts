import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StripHooks } from './engine'
import { GAMES } from './games'
import type { Arcade } from './index'
import { wireArcade } from './wire'

afterEach(() => vi.restoreAllMocks())

const settle = () => new Promise((r) => setTimeout(r, 0))

function fakeArcade(): Arcade & { [k: string]: ReturnType<typeof vi.fn> } {
  return {
    output: vi.fn(),
    input: vi.fn(),
    next: vi.fn(async () => {}),
    pick: vi.fn(async () => {}),
    stop: vi.fn(),
  }
}

function setup(o: { on?: boolean; arcade?: Arcade | null } = {}) {
  const arcade = o.arcade === undefined ? fakeArcade() : o.arcade
  let onEnabled: (on: boolean) => void = () => {}
  const api = {
    enabled: vi.fn(async () => o.on ?? true),
    onEnabled: vi.fn((cb: (on: boolean) => void) => {
      onEnabled = cb
      return () => {}
    }),
    pick: vi.fn(async () => null),
    turnOn: vi.fn(),
  }
  let resolveLoad: () => void = () => {}
  const loaded = new Promise<void>((r) => {
    resolveLoad = r
  })
  const startArcade = vi.fn(async (_bar: HTMLElement, _hooks?: StripHooks) => arcade)
  const load = vi.fn(async () => {
    await loaded
    return { startArcade }
  })
  const events = new EventTarget()
  const gaze = vi.fn()
  const bar = {} as HTMLElement
  const wiring = wireArcade(bar, { api, events, gaze, load })
  return {
    wiring,
    api,
    arcade,
    load,
    startArcade,
    events,
    gaze,
    bar,
    finishLoad: async () => {
      resolveLoad()
      await settle()
    },
    setEnabled: (on: boolean) => onEnabled(on),
    next: () => events.dispatchEvent(new CustomEvent('aico:arcade-next')),
    pick: (key: string) =>
      events.dispatchEvent(new CustomEvent('aico:arcade-pick', { detail: key })),
  }
}

describe('titlebar arcade wiring', () => {
  it('loads no engine while the games are off', async () => {
    const t = setup({ on: false })
    await t.finishLoad()
    expect(t.load).not.toHaveBeenCalled()
    t.wiring.output(true)
    t.wiring.input()
  })

  it('loads the engine and starts this window’s game once the games are on', async () => {
    const t = setup()
    await settle()
    expect(t.load).toHaveBeenCalledTimes(1)
    await t.finishLoad()
    expect(t.startArcade).toHaveBeenCalledWith(t.bar, expect.anything())
    t.wiring.output(true)
    t.wiring.input()
    expect(t.arcade?.output).toHaveBeenCalledWith(true)
    expect(t.arcade?.input).toHaveBeenCalledTimes(1)
  })

  it('passes the game’s gaze to the eyes, and hands them back when turned off', async () => {
    const t = setup()
    await t.finishLoad()
    t.startArcade.mock.calls[0]?.[1]?.gaze?.({ x: 1, y: 2 })
    expect(t.gaze).toHaveBeenLastCalledWith({ x: 1, y: 2 })
    t.setEnabled(false)
    expect(t.arcade?.stop).toHaveBeenCalledTimes(1)
    expect(t.gaze).toHaveBeenLastCalledWith(null)
  })

  it('turned off while the engine loads: the game stops as soon as it arrives', async () => {
    const t = setup()
    await settle()
    t.setEnabled(false)
    await t.finishLoad()
    expect(t.arcade?.stop).toHaveBeenCalledTimes(1)
    t.wiring.output(true)
    expect(t.arcade?.output).not.toHaveBeenCalled()
  })

  it('turned on twice while loading starts one game', async () => {
    const t = setup()
    await settle()
    t.setEnabled(true)
    await t.finishLoad()
    expect(t.startArcade).toHaveBeenCalledTimes(1)
  })

  it('Next game swaps this window’s game while one is showing', async () => {
    const t = setup()
    await t.finishLoad()
    t.next()
    expect(t.arcade?.next).toHaveBeenCalledTimes(1)
    expect(t.api.turnOn).not.toHaveBeenCalled()
  })

  it('Next game turns the games on while they are off or still loading, never toggling them', async () => {
    const t = setup({ on: false })
    t.next()
    t.next()
    expect(t.api.turnOn).toHaveBeenCalledTimes(2)
  })

  it('Choose game picks in this window while a game is showing', async () => {
    const t = setup()
    await t.finishLoad()
    t.pick('birds')
    expect(t.arcade?.pick).toHaveBeenCalledWith('birds')
    expect(t.api.pick).not.toHaveBeenCalled()
  })

  it('Choose game while off asks main to turn the games on with that game', () => {
    const t = setup({ on: false })
    t.pick('birds')
    expect(t.api.pick).toHaveBeenCalledWith(
      'birds',
      GAMES.map((g) => g.key),
    )
  })

  it('logs a failed swap', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('no game')
    const arcade = fakeArcade()
    arcade.next = vi.fn(async () => Promise.reject(failure))
    const t = setup({ arcade })
    await t.finishLoad()
    t.next()
    await settle()
    expect(error).toHaveBeenCalledWith('[arcade]', failure)
  })
})
