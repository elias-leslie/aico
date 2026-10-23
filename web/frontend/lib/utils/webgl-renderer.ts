/**
 * Whether a pane should use xterm.js's WebGL renderer.
 *
 * WebGL is the fast path on desktop, but on Android Chrome it is unreliable:
 * depending on the GPU driver it either paints nothing at all (the whole
 * terminal stays blank while input still reaches the session) or samples the
 * glyph atlas wrong, which puts characters on visibly different baselines.
 * The DOM renderer has no such failure mode and is fast enough for a
 * phone-sized pane, so Android gets it and everything else keeps WebGL.
 */
export function isWebglUnreliablePlatform(
  userAgent: string = typeof navigator === 'undefined'
    ? ''
    : navigator.userAgent,
): boolean {
  return /Android/i.test(userAgent)
}

export function shouldUseWebglRenderer(userAgent?: string): boolean {
  return !isWebglUnreliablePlatform(userAgent)
}
