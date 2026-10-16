import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextGame } from './next-game'

afterEach(() => vi.restoreAllMocks())

describe('Next game', () => {
  it("swaps this window's game while one is showing", () => {
    const arcade = { next: vi.fn(async () => {}) }
    const bridge = { turnOn: vi.fn() }
    nextGame(arcade, bridge)
    expect(arcade.next).toHaveBeenCalledTimes(1)
    expect(bridge.turnOn).not.toHaveBeenCalled()
  })

  it('turns the games on while they are off or still loading, never toggling them', () => {
    const bridge = { turnOn: vi.fn() }
    nextGame(null, bridge)
    nextGame(null, bridge)
    expect(bridge.turnOn).toHaveBeenCalledTimes(2)
  })

  it('logs a failed swap', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('no game')
    nextGame({ next: vi.fn(async () => Promise.reject(failure)) }, { turnOn: vi.fn() })
    await new Promise((r) => setTimeout(r, 0))
    expect(error).toHaveBeenCalledWith('[arcade]', failure)
  })
})
