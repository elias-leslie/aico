// Ctrl+click a URL in the terminal to open it in the browser. Works inside
// mouse-grabbing TUIs too (Claude Code), because Aico reads the URL from the
// terminal buffer itself instead of relying on the program to handle the click.

const URL_RE = /https?:\/\/[^\s<>"'`]+/g
/** Trailing punctuation that is almost always prose, not part of the URL. */
const TRAILING = /[.,;:!?)\]}>'"]+$/

/** The http(s) URL in `line` covering column `col`, or null. */
export function urlAt(line: string, col: number): string | null {
  for (const match of line.matchAll(URL_RE)) {
    const start = match.index ?? 0
    let url = match[0]
    // Keep a closing paren only when the URL opened one, e.g. a wiki link.
    const trailing = url.match(TRAILING)?.[0] ?? ''
    if (trailing) {
      const opens = (url.match(/\(/g) ?? []).length
      const closes = (url.match(/\)/g) ?? []).length
      url =
        trailing.startsWith(')') && opens >= closes
          ? url
          : url.slice(0, url.length - trailing.length)
    }
    if (col >= start && col < start + url.length) return url
  }
  return null
}
