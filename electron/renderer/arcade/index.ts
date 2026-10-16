// Titlebar arcade: loads the game main assigned to this window and runs it in
// the titlebar. Each game is its own chunk, so a window only loads the ones it
// shows; this module (the engine) is a chunk of its own too, loaded by wire.ts
// only once the games are on.
import { ActivityGate } from './activity'
import { conceptFor, installGlobals, type Point, Strip, type StripHooks } from './engine'
import { games, keyOf } from './games'

export interface Arcade {
  /** Terminal output started (true) or settled (false). */
  output(on: boolean): void
  /** The user typed into the terminal. */
  input(): void
  /** Swap to another game (one this window hasn't shown yet). */
  next(): Promise<void>
  /** Swap to this game. */
  pick(key: string): Promise<void>
  /** Stop for good: the game, its canvas and every listener. */
  stop(): void
}

export async function startArcade(
  bar: HTMLElement,
  hooks: StripHooks = {},
): Promise<Arcade | null> {
  const paths = new Map(Object.keys(games).map((p) => [keyOf(p), p]))
  const keys = [...paths.keys()]
  installGlobals()
  let strip: Strip | null = null

  const show = async (key: string | null): Promise<boolean> => {
    const path = key ? paths.get(key) : undefined
    const load = path ? games[path] : undefined
    if (!key || !load) return false
    await load()
    const def = conceptFor(key)
    if (!def) return false
    const busy = strip?.busy ?? false
    strip?.destroy()
    strip = new Strip(def, bar, hooks)
    if (busy) strip.setBusy(true)
    bar.dataset.arcade = key
    return true
  }

  if (!(await show(await window.aico.arcade.assign(keys)))) return null
  const unCursor = window.aico.arcade.onCursor((pt) => {
    if (!pt) return strip?.setCursor(null)
    // main sends window coordinates; the bar starts at the top of the window
    const b = bar.getBoundingClientRect()
    strip?.setCursor({ x: pt.x - b.left, y: pt.y - b.top } satisfies Point)
  })
  const life = new AbortController()
  bar.addEventListener('mouseleave', () => strip?.setCursor(null), { signal: life.signal })
  const gate = new ActivityGate((busy, ran) => strip?.setBusy(busy, ran))
  let swapping = false
  return {
    output: (on) => gate.output(on),
    input: () => {
      gate.input()
      strip?.touch()
    },
    next: async () => {
      if (swapping) return
      swapping = true
      try {
        await show(await window.aico.arcade.next(keys))
      } finally {
        swapping = false
      }
    },
    pick: async (key) => {
      if (swapping || key === bar.dataset.arcade) return
      swapping = true
      try {
        await show(await window.aico.arcade.pick(key, keys))
      } finally {
        swapping = false
      }
    },
    stop: () => {
      unCursor()
      life.abort()
      strip?.destroy()
      strip = null
      delete bar.dataset.arcade
    },
  }
}
