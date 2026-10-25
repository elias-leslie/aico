// Boundary checks for renderer-supplied IPC payloads. The renderer is
// sandboxed, but main treats its messages as untrusted input all the same.

/** Pinned action ids: a bounded list of short strings, or nothing. */
export function parsePins(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > 64) return null
  return input.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
    ? (input as string[])
    : null
}
