/// <reference types="vite/client" />
// Titlebar arcade: loads the game main assigned to this window and runs it in
// the titlebar. Each game is its own chunk, so a window only loads the one it
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
}

export async function startArcade(
  bar: HTMLElement,
  hooks: StripHooks = {},
): Promise<Arcade | null> {
  const paths = new Map(Object.keys(games).map((p) => [keyOf(p), p]))
  const key = await window.aico.arcade.assign([...paths.keys()])
  const path = key ? paths.get(key) : undefined
  const load = path ? games[path] : undefined
  if (!key || !load) return null
  installGlobals()
  await load()
  const def = conceptFor(key)
  if (!def) return null
  const strip = new Strip(def, bar, hooks)
  bar.dataset.arcade = key
  window.aico.arcade.onCursor((pt) => {
    if (!pt) return strip.setCursor(null)
    // main sends window coordinates; the bar starts at the top of the window
    const b = bar.getBoundingClientRect()
    strip.setCursor({ x: pt.x - b.left, y: pt.y - b.top } satisfies Point)
  })
  bar.addEventListener('mouseleave', () => strip.setCursor(null))
  const gate = new ActivityGate((busy, ran) => strip.setBusy(busy, ran))
  return {
    output: (on) => gate.output(on),
    input: () => {
      gate.input()
      strip.touch()
    },
  }
}
