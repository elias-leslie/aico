// The left side's four widths (mockup 2): a rail of icons and counts, the
// panel beside the session (the default), wide (the panel plus a second
// column) and full (covers the session; Esc or close brings it back).
// Dragging its edge snaps to the nearest one; the width never decides which
// session is open.

export const TIERS = ['rail', 'panel', 'wide', 'full'] as const
export type Tier = (typeof TIERS)[number]
/** The tiers kept on this device: full covers the session, so a reload never opens on it. */
export type DockedTier = Exclude<Tier, 'full'>

export const TIER_LABEL: Record<Tier, string> = {
  rail: 'Rail',
  panel: 'Panel',
  wide: 'Wide',
  full: 'Full',
}

export const RAIL_PX = 64
export const PANEL_PX = 360
/** Wide takes this share of the window beside the top bar. */
const WIDE_SHARE = 0.58
export const DEFAULT_TIER: DockedTier = 'panel'
/** The kept tier on this device. */
export const TIER_STORAGE_KEY = 'aico-left-tier'

const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && (TIERS as readonly string[]).includes(value)

export const isDocked = (value: unknown): value is DockedTier =>
  isTier(value) && value !== 'full'

/** A tier's width in px inside a frame `frameWidth` wide. */
export function tierWidth(tier: Tier, frameWidth: number): number {
  if (tier === 'rail') return RAIL_PX
  if (tier === 'panel') return Math.min(PANEL_PX, frameWidth)
  if (tier === 'wide')
    return Math.max(PANEL_PX, Math.round(frameWidth * WIDE_SHARE))
  return frameWidth
}

/** The tier a drag let go at `width` snaps to: the nearest snap point. */
export function nearestTier(width: number, frameWidth: number): Tier {
  let best: Tier = 'panel'
  let distance = Number.POSITIVE_INFINITY
  for (const tier of TIERS) {
    const gap = Math.abs(tierWidth(tier, frameWidth) - width)
    if (gap < distance) {
      best = tier
      distance = gap
    }
  }
  return best
}

/** One step narrower (-1) or wider (+1), stopping at the ends. */
export function stepTier(tier: Tier, direction: -1 | 1): Tier {
  const index = TIERS.indexOf(tier) + direction
  return TIERS[Math.min(TIERS.length - 1, Math.max(0, index))] as Tier
}

type KeyLike = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'
>

/**
 * The tier keys: Alt+1 to Alt+4 jump to a tier, Alt+[ and Alt+] step. By
 * key position (`code`), so a layout where Alt types a symbol still works.
 */
export function tierKey(
  event: KeyLike,
): { tier: Tier } | { step: -1 | 1 } | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return null
  const digit = /^Digit([1-4])$/.exec(event.code)
  if (digit) return { tier: TIERS[Number(digit[1]) - 1] as Tier }
  if (event.code === 'BracketLeft') return { step: -1 }
  if (event.code === 'BracketRight') return { step: 1 }
  return null
}

/** The tooltip on the edge: what dragging does and every key. */
export const HANDLE_HELP =
  'Drag to resize; it snaps to Rail, Panel, Wide or Full. Double-click for Panel. Alt+1 to Alt+4 pick one, Alt+[ and Alt+] step, Esc goes back to Panel.'
