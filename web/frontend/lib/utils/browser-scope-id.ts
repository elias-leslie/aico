export function createBrowserScopeId(prefix: string): string {
  if (typeof crypto === 'undefined') {
    throw new Error('Browser crypto is required to create scope IDs')
  }
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `${prefix}-${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`
}
