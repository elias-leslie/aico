'use client'

import { useEffect, useRef } from 'react'

/** A request to show Needs you: the frame brings the side's list to the
 * front and the Needs you section scrolls to it, one question first. */
export interface NeedsYouRequest {
  focus: string | null
}
const NEEDS_YOU_EVENT = 'aico:needs-you'
let pendingRequest: NeedsYouRequest | null = null

/** Show Needs you, with one question first (a push link, a session's own
 * question). */
export function openNeedsYou(focus: string | null = null): void {
  pendingRequest = { focus }
  window.dispatchEvent(new CustomEvent(NEEDS_YOU_EVENT, { detail: { focus } }))
}

/** The push link (`?ask=<id>`): read once on load, then dropped from the URL
 * so a reload does not reopen it. */
export function takeAskFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const id = url.searchParams.get('ask')
  if (id === null) return null
  url.searchParams.delete('ask')
  window.history.replaceState(window.history.state, '', url)
  return /^[0-9a-f]{12}$/.test(id) ? id : null
}

/** Hear requests to show Needs you: `onRequest` runs for each, and for one
 * made before this was mounted (the side opens after the click). */
export function useNeedsYouRequests(
  onRequest: (request: NeedsYouRequest) => void,
  { replay = true }: { replay?: boolean } = {},
): void {
  const handler = useRef(onRequest)
  handler.current = onRequest
  useEffect(() => {
    const listen = (event: Event) => {
      if (replay) pendingRequest = null
      handler.current((event as CustomEvent<NeedsYouRequest>).detail)
    }
    window.addEventListener(NEEDS_YOU_EVENT, listen)
    if (replay && pendingRequest) {
      const request = pendingRequest
      pendingRequest = null
      handler.current(request)
    }
    return () => window.removeEventListener(NEEDS_YOU_EVENT, listen)
  }, [replay])
}
