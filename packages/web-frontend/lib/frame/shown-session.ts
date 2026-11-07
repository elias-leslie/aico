// The session on screen, so a page's Back and Esc come home to it rather than
// to whatever home would pick on its own. The session view publishes its id.

let shown: string | null = null

/** The open session's id; null: no session open. */
export function publishShownSession(id: string | null) {
  shown = id
}

/** The id of the session on screen, or null: none open. */
export function shownSession(): string | null {
  return shown
}

/** Home with the session on screen: leaving a page comes back to it, not to
 * whatever home would pick on its own. */
export function homeHref(): string {
  return shown ? `/?session=${encodeURIComponent(shown)}` : '/'
}
