'use client'

import { useCallback, useRef } from 'react'

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const PASTE_CHUNK_CHARS = 1_024
const PASTE_CHUNK_DELAY_MS = 8

export function useBracketedPaste(
  sendInput: (data: string) => void,
): (data: string) => void {
  const pasteQueueRef = useRef(Promise.resolve())

  return useCallback(
    (data: string) => {
      // Normalize line endings: \r\n → \n, then strip any lone \r.
      // Without this, PTY icrnl converts \r to \n, so \r\n becomes \n\n
      // (double newlines on paste).
      const normalized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

      pasteQueueRef.current = pasteQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          sendInput(BRACKETED_PASTE_START)

          for (let start = 0; start < normalized.length; start += PASTE_CHUNK_CHARS) {
            sendInput(normalized.slice(start, start + PASTE_CHUNK_CHARS))
            if (start + PASTE_CHUNK_CHARS < normalized.length) {
              await new Promise((resolve) =>
                setTimeout(resolve, PASTE_CHUNK_DELAY_MS),
              )
            }
          }

          sendInput(BRACKETED_PASTE_END)
        })
    },
    [sendInput],
  )
}
