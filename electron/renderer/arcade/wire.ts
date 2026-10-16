// The titlebar arcade in a window: a game main assigns this window for its
// lifetime, until "Next game" swaps it. The engine (index.ts) loads only once
// the games are on, after first paint, and never blocks the terminal. The games
// can be turned off for every window; off, nothing here runs.
import type { StripHooks } from './engine'
import { GAMES } from './games'
import type { Arcade } from './index'

type ArcadeBridge = Pick<Window['aico']['arcade'], 'enabled' | 'onEnabled' | 'pick' | 'turnOn'>

interface ArcadeDeps {
  api: ArcadeBridge
  /** Where the lantern menu's "Choose game" and "Next game" events arrive. */
  events: Pick<EventTarget, 'addEventListener'>
  /** Where the eyes should look while a game runs; null hands them back. */
  gaze?: StripHooks['gaze']
  /** Loads the engine; tests pass a stand-in. */
  load?: () => Promise<Pick<typeof import('./index'), 'startArcade'>>
}

export interface ArcadeWiring {
  /** Terminal output started (true) or settled (false). */
  output(on: boolean): void
  /** The user typed into the terminal. */
  input(): void
  /** The window's eyes fell asleep (true) or woke (false); off, nothing runs. */
  nap(on: boolean): void
}

const logError = (err: unknown): void => console.error('[arcade]', err)

export function wireArcade(bar: HTMLElement, deps: ArcadeDeps): ArcadeWiring {
  const { api, events } = deps
  const load = deps.load ?? (() => import('./index'))
  let arcade: Arcade | null = null
  let wanted = false
  let starting = false
  /** The eyes sleep: games turned on now nap too, once they go quiet. */
  let asleep = false

  const start = (): void => {
    wanted = true
    if (arcade || starting) return
    starting = true
    load()
      .then(({ startArcade }) => startArcade(bar, { gaze: (pt) => deps.gaze?.(pt) }))
      .then((a) => {
        if (!wanted) {
          a?.stop() // turned off while it was loading
          return
        }
        arcade = a
        if (asleep) a?.nap(true)
      })
      .catch(logError)
      .finally(() => {
        starting = false
      })
  }
  const stop = (): void => {
    wanted = false
    arcade?.stop()
    arcade = null
    deps.gaze?.(null)
  }

  api
    .enabled()
    .then((on) => {
      if (on) start()
    })
    .catch(logError)
  api.onEnabled((on) => (on ? start() : stop()))

  events.addEventListener('aico:arcade-pick', (e) => {
    const key = (e as CustomEvent<string>).detail
    if (arcade) {
      arcade.pick(key).catch(logError)
      return
    }
    // games are off (or still loading): main turns them on with this one assigned
    api
      .pick(
        key,
        GAMES.map((g) => g.key),
      )
      .catch(logError)
  })
  // "Next game": swap this window's game for one it hasn't shown. While the
  // games are off (or this window's game is still loading) it turns them on
  // instead, and this window then gets a game it hasn't shown. Turning on is
  // idempotent in main, so a press while a game loads, or two windows pressing
  // at once, can never turn the games off.
  events.addEventListener('aico:arcade-next', () => {
    if (arcade) arcade.next().catch(logError)
    else api.turnOn()
  })

  return {
    output: (on) => arcade?.output(on),
    input: () => arcade?.input(),
    nap: (on) => {
      asleep = on
      arcade?.nap(on)
    },
  }
}
