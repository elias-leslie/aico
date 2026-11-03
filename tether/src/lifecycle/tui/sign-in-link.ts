// The sign-in link a tool prints on its sign-in screen. Tools wrap the long
// OAuth URL across lines (agy: hard line breaks at the pane width, or inside a
// box), so the screen's text is not a usable link. This joins the pieces and
// returns the URL only when it parses as https on the host the adapter names
// (`login.signInLink.host`, adapters/contract.ts).

/** The title of a sign-in session opened for `<tool>` (hub/host-admin.ts). */
export const SIGN_IN_TITLE = 'Sign in: '

/** The tool a sign-in session title names, else null. */
export function signInToolOf(title: string | null | undefined): string | null {
  return title?.startsWith(SIGN_IN_TITLE) ? title.slice(SIGN_IN_TITLE.length) : null
}

const EDGE = /^[\s─-▟]+|[\s─-▟]+$/g

/** The last URL on `screen` (visible pane text) whose host is `host`, joined
 * across wrapped lines; null when there is none. */
export function extractSignInLink(screen: string, host: string): string | null {
  const lines = screen.split('\n').map((line) => line.replace(EDGE, ''))
  let found: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].match(/https:\/\/\S+/)
    if (!start) continue
    let url = start[0]
    // A line that ends the URL's last line is shorter than the ones before it,
    // so a line after a short one is not a continuation.
    let width = 0
    if (start.index !== undefined && start.index + url.length === lines[i].length) {
      for (let j = i + 1; j < lines.length; j++) {
        const piece = lines[j]
        if (!piece || /\s/.test(piece)) break
        url += piece
        if (piece.length < width) break
        width = piece.length
      }
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' && parsed.hostname === host) found = url
    } catch {
      // Not a URL.
    }
  }
  return found
}
