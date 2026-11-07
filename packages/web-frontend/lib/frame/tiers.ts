// The left side's widths: a rail of icons and counts, or the panel beside the
// session (the default). One toggle flips between them. Dragging the edge
// snaps to the rail or sets the panel's width; wider than its default the panel
// covers part of the session without resizing it. Full is not a width: it is a
// page (History, a project, Restore files) shown over the session, left with
// Esc or its close button. An expanded item that needs room widens the panel
// for as long as it is open (WIDEN_PX), without changing the tier.

const TIERS = ['rail', 'panel', 'full'] as const
export type Tier = (typeof TIERS)[number]
/** The tiers kept on this device: full covers the session, so a reload never opens on it. */
export type DockedTier = Exclude<Tier, 'full'>

export const RAIL_PX = 64
export const PANEL_PX = 360
/** The panel while an expanded item needs more room (capped at this share of the window). */
export const WIDEN_PX = 560
export const WIDEN_SHARE = 0.58
export const DEFAULT_TIER: DockedTier = 'panel'
/** The kept tier on this device. */
export const TIER_STORAGE_KEY = 'aico-left-tier'
/** A desktop window too narrow for Panel beside the session (snapped to part
 * of a screen) keeps its own tier, Rail unless chosen otherwise. */
export const COMPACT_DEFAULT_TIER: DockedTier = 'rail'
export const COMPACT_TIER_STORAGE_KEY = 'aico-left-tier-compact'

export const isDocked = (value: unknown): value is DockedTier =>
  value === 'rail' || value === 'panel'

/** A drag that ends this close to the default width keeps the default. */
const SNAP_PX = 24
/** The panel's widest size, as a share of the window. */
export const PANEL_MAX_SHARE = 0.9
/** The panel's width kept on this device (px); the default when never dragged. */
export const PANEL_WIDTH_STORAGE_KEY = 'aico-panel-width'

/** A tier's width in px inside a frame `frameWidth` wide. */
export function tierWidth(tier: Tier, frameWidth: number): number {
  if (tier === 'rail') return RAIL_PX
  if (tier === 'panel') return Math.min(PANEL_PX, frameWidth)
  return frameWidth
}

/** The panel width a drag let go at `width` keeps: the default when close to it, never past the cap. */
export function panelWidthAt(width: number, frameWidth: number): number {
  const max = Math.max(PANEL_PX, Math.floor(frameWidth * PANEL_MAX_SHARE))
  const clamped = Math.min(max, Math.max(PANEL_PX, Math.round(width)))
  return clamped - PANEL_PX < SNAP_PX ? PANEL_PX : clamped
}
/** Where a drag let go at `width` lands: the rail when pulled in past halfway, else the panel. */
export function nearestTier(width: number): 'rail' | 'panel' {
  return width < (RAIL_PX + PANEL_PX) / 2 ? 'rail' : 'panel'
}

/** The other one: the rail opens to the panel, the panel folds to the rail. */
export function toggledTier(tier: Tier): DockedTier {
  return tier === 'panel' ? 'rail' : 'panel'
}

type KeyLike = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'
>

/**
 * The tier keys: Alt+1 the rail, Alt+2 the panel, Alt+[ or Alt+] flips between them. By
 * key position (`code`), so a layout where Alt types a symbol still works.
 */
export function tierKey(
  event: KeyLike,
): { tier: DockedTier } | { toggle: true } | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return null
  if (event.code === 'Digit1') return { tier: 'rail' }
  if (event.code === 'Digit2') return { tier: 'panel' }
  if (event.code === 'BracketLeft' || event.code === 'BracketRight')
    return { toggle: true }
  return null
}

/** The tooltip on the edge: what dragging does and every key. */
export const HANDLE_HELP =
  'Drag to resize; pull in to the rail, or out to cover more of the session. Double-click for the default width. Alt+1 rail, Alt+2 panel, Alt+[ flips.'
