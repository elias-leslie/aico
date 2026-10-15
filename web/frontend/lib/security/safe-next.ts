/**
 * The same-origin path a `next` parameter may send the browser to after sign-in, or '/'.
 * Refuses other origins, including protocol-relative `//evil` and `/\evil` (browsers read `\` as `/`), and login loops.
 */
export function safeNextPath(next: string | null, base: string): string {
  if (!next) return '/'
  try {
    const origin = new URL(base).origin
    const target = new URL(next, origin)
    if (target.origin !== origin) return '/'
    const path = `${target.pathname}${target.search}${target.hash}`
    return path.startsWith('/login') ? '/' : path
  } catch {
    return '/'
  }
}
