/**
 * Serialises clipboard pastes so one user gesture pastes once.
 *
 * Right-click and Ctrl+Shift+V both route through here. A gesture can reach us
 * more than once (a repeated contextmenu dispatch, key auto-repeat, or the
 * native paste event Chromium fires alongside Ctrl+Shift+V), so a request is
 * dropped while another read is in flight or if it lands within `windowMs`
 * of the last completed paste.
 */
export function createPasteGuard(
  read: () => Promise<string>,
  paste: (text: string) => void,
  windowMs = 400,
  now: () => number = () => Date.now(),
): () => Promise<void> {
  let busy = false
  let last = Number.NEGATIVE_INFINITY
  return async () => {
    if (busy || now() - last < windowMs) return
    busy = true
    try {
      const text = await read()
      if (text) paste(text)
    } finally {
      last = now()
      busy = false
    }
  }
}
