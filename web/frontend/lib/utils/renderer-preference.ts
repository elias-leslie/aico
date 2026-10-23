/**
 * Which xterm.js renderer a pane should use.
 *
 * The WebGL renderer is the fast path on desktop, but on Android Chrome it is
 * unreliable: depending on the GPU driver it either paints nothing at all
 * (the whole terminal stays blank while input still reaches the session) or
 * samples the glyph atlas wrong, which puts characters on visibly different
 * baselines. The DOM renderer has no such failure mode and is fast enough for
 * a phone-sized pane, so `auto` picks it there and keeps WebGL everywhere else.
 */
export const A_TERM_RENDERER_OPTIONS = ['auto', 'webgl', 'dom'] as const

export type ATermRendererPreference = (typeof A_TERM_RENDERER_OPTIONS)[number]

export const RENDERER_STORAGE_KEY = 'a-term-renderer'

export function isRendererPreference(
  value: unknown,
): value is ATermRendererPreference {
  return (
    typeof value === 'string' &&
    (A_TERM_RENDERER_OPTIONS as readonly string[]).includes(value)
  )
}

export function getRendererPreference(): ATermRendererPreference {
  if (typeof window === 'undefined') return 'auto'
  try {
    const stored = window.localStorage.getItem(RENDERER_STORAGE_KEY)
    return isRendererPreference(stored) ? stored : 'auto'
  } catch {
    return 'auto'
  }
}

export function setRendererPreference(value: ATermRendererPreference): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RENDERER_STORAGE_KEY, value)
  } catch {
    // Storage unavailable (private mode) — the preference just won't persist.
  }
}

/** True for the platforms where the WebGL renderer misdraws terminal output. */
export function isWebglUnreliablePlatform(
  userAgent: string = typeof navigator === 'undefined'
    ? ''
    : navigator.userAgent,
): boolean {
  return /Android/i.test(userAgent)
}

export function shouldUseWebglRenderer(
  preference: ATermRendererPreference = getRendererPreference(),
  userAgent?: string,
): boolean {
  if (preference === 'webgl') return true
  if (preference === 'dom') return false
  return !isWebglUnreliablePlatform(userAgent)
}
