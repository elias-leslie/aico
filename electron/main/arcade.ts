// Titlebar arcade: each widget window gets one game vignette for its lifetime.
// Main owns the assignment so open windows don't repeat a game until every game
// is already showing somewhere.

const KEY = /^[a-z0-9]{1,32}$/

/** Renderer-supplied concept keys: a bounded list of short lowercase ids. */
export function parseArcadeKeys(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) return null
  if (!input.every((k) => typeof k === 'string' && KEY.test(k))) return null
  return [...new Set(input as string[])]
}

/** Pick a game for a new window: one no other open window shows, or, when all
 * are showing, one of the least-shown. Random within that set. */
export function pickArcade(
  keys: readonly string[],
  inUse: Iterable<string>,
  rand: () => number = Math.random,
): string | null {
  if (keys.length === 0) return null
  const count = new Map(keys.map((k) => [k, 0]))
  for (const k of inUse) if (count.has(k)) count.set(k, (count.get(k) ?? 0) + 1)
  const least = Math.min(...count.values())
  const pool = keys.filter((k) => count.get(k) === least)
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))] ?? null
}

/** Cycle a window to another game. Games open in other windows stay off
 * limits while a free one exists; among those, the window gets one it hasn't
 * shown yet, and once it has shown them all its history starts over. Returns
 * the new game and the window's updated history. */
export function nextArcade(
  keys: readonly string[],
  current: string | undefined,
  others: Iterable<string>,
  shown: ReadonlySet<string>,
  rand: () => number = Math.random,
): { key: string | null; shown: Set<string> } {
  const choices = keys.length > 1 ? keys.filter((k) => k !== current) : [...keys]
  const count = new Map(choices.map((k) => [k, 0]))
  for (const k of others) if (count.has(k)) count.set(k, (count.get(k) ?? 0) + 1)
  const least = Math.min(...count.values())
  const free = choices.filter((k) => count.get(k) === least)
  const fresh = free.filter((k) => !shown.has(k))
  const history = fresh.length ? new Set(shown) : new Set(current ? [current] : [])
  const key = pickArcade(fresh.length ? fresh : free, [], rand)
  if (key) history.add(key)
  return { key, shown: history }
}

/** How far around a window the cursor still counts as "near the titlebar". */
const ARCADE_BAND = { side: 16, above: 40, below: 120 }

/** The cursor in window-content coordinates while it is near the top of the
 * window (the titlebar plus a margin), else null. */
export function cursorNearTitlebar(
  pt: { x: number; y: number },
  content: { x: number; y: number; width: number; height: number },
): { x: number; y: number } | null {
  const x = pt.x - content.x
  const y = pt.y - content.y
  if (x < -ARCADE_BAND.side || x > content.width + ARCADE_BAND.side) return null
  if (y < -ARCADE_BAND.above || y > Math.min(content.height, ARCADE_BAND.below)) return null
  return { x, y }
}
