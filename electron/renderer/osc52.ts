// OSC 52: a program in the pane sets the clipboard. tmux forwards it (its
// `clipboard` terminal feature) when Claude Code copies its own selection or
// anything runs `tmux load-buffer -w`. Writes only: a query ("?") would let the
// pane read the clipboard back, so it is ignored.

/** Max clipboard text a pane may set (bytes of base64 before decoding). */
export const OSC52_MAX = 1_000_000

/** The text an OSC 52 payload ("c;BASE64") sets, or null to ignore it. */
export function osc52Text(data: string): string | null {
  const split = data.indexOf(';')
  if (split < 0) return null
  const payload = data.slice(split + 1)
  if (!payload || payload === '?' || payload.length > OSC52_MAX) return null
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
