// Boundary checks for renderer-supplied IPC payloads. The renderer is
// sandboxed, but main treats its messages as untrusted input all the same.

/** Renderer-supplied window bounds: finite numbers only, at least 1px. */
export function parseBoundsRequest(
  input: unknown,
): { x: number; y: number; width: number; height: number } | null {
  if (!input || typeof input !== 'object') return null
  const { x, y, w, h } = input as Record<string, unknown>
  const values = [x, y, w, h]
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const [bx, by, bw, bh] = (values as number[]).map(Math.round)
  if (bw < 1 || bh < 1) return null
  return { x: bx, y: by, width: bw, height: bh }
}

/** Pinned action ids: a bounded list of short strings, or nothing. */
export function parsePins(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > 64) return null
  return input.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
    ? (input as string[])
    : null
}
