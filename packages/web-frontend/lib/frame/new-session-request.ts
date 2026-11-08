'use client'

import { useEffect, useRef } from 'react'

const EVENT = 'aico:new-session'

/** Ask for the New session dialog with a project already picked ("New session here"). */
export function requestNewSession(projectId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId } }))
}

/** Hear those requests; the session side opens its dialog on the project. */
export function useNewSessionRequests(
  onRequest: (projectId: string) => void,
): void {
  const handler = useRef(onRequest)
  handler.current = onRequest
  useEffect(() => {
    const listen = (event: Event) => {
      const id = (event as CustomEvent<{ projectId?: string }>).detail
        ?.projectId
      if (id) handler.current(id)
    }
    window.addEventListener(EVENT, listen)
    return () => window.removeEventListener(EVENT, listen)
  }, [])
}
