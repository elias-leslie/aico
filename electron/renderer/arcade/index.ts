/// <reference types="vite/client" />
// Titlebar arcade: loads the game main assigned to this window and runs it in
// the titlebar. Each game is its own chunk, so a window only loads the ones it
// shows.
import { ActivityGate } from './activity'
import { conceptFor, installGlobals, type Point, Strip, type StripHooks } from './engine'

const games = import.meta.glob('./concepts/*.js')
const keyOf = (path: string): string => path.replace(/^.*\/([a-z0-9]+)\.js$/, '$1')

export interface Arcade {
  /** Terminal output started (true) or settled (false). */
  output(on: boolean): void
  /** The user typed into the terminal. */
  input(): void
  /** Swap to another game (one this window hasn't shown yet). */
  next(): Promise<void>
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
  window.aico.arcade.onCursor((pt) => {
    if (!pt) return strip?.setCursor(null)
    // main sends window coordinates; the bar starts at the top of the window
    const b = bar.getBoundingClientRect()
    strip?.setCursor({ x: pt.x - b.left, y: pt.y - b.top } satisfies Point)
  })
  bar.addEventListener('mouseleave', () => strip?.setCursor(null))
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
  }
}
