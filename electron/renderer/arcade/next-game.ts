import type { Arcade } from './index'

/**
 * "Next game" from the lantern menu: swap this window's game for one it hasn't
 * shown. While the games are off (or this window's game is still loading) it
 * turns them on instead, and this window then gets a game it hasn't shown.
 * Turning on is idempotent in main, so a press while a game loads, or two
 * windows pressing at once, can never turn the games off.
 */
export function nextGame(arcade: Pick<Arcade, 'next'> | null, bridge: { turnOn(): void }): void {
  if (arcade) {
    arcade.next().catch((err: unknown) => console.error('[arcade]', err))
    return
  }
  bridge.turnOn()
}
