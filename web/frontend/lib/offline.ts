'use client'

import { useSyncExternalStore } from 'react'

/** What the service worker last said: it is answering from the saved copy, and how fresh the notes in it are. */
export interface OfflineState {
  offline: boolean
  /** When notes were last fetched from a host (ms), or null: nothing saved on this device yet. */
  notesAt: number | null
}

const IDLE: OfflineState = { offline: false, notesAt: null }
let current = IDLE
const listeners = new Set<() => void>()

function publish(next: OfflineState) {
  if (next.offline === current.offline && next.notesAt === current.notesAt)
    return
  current = next
  for (const listener of listeners) listener()
}

/** Follow the service worker's messages; returns the stop function. Call once, from the app's providers. */
export function watchOffline(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
    return () => {}
  const container = navigator.serviceWorker
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string } & Partial<OfflineState>
    if (data?.type !== 'aico-state') return
    publish({ offline: data.offline === true, notesAt: data.notesAt ?? null })
  }
  container.addEventListener('message', onMessage)
  // The worker may have spoken before this page was listening; ask for where things stand.
  container.ready
    .then((registration) =>
      registration.active?.postMessage({ type: 'aico-state?' }),
    )
    .catch(() => {})
  return () => container.removeEventListener('message', onMessage)
}

export function useOffline(): OfflineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
    () => IDLE,
  )
}

/** "10:42", or "Mon 10:42" when it was not today. */
export function formatSavedTime(at: number, now = Date.now()): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** The banner's words. */
export function offlineMessage(state: OfflineState, now = Date.now()): string {
  return state.notesAt === null
    ? 'Both hosts are offline. No notes are saved on this device yet. Read-only.'
    : `Both hosts are offline. Showing notes from ${formatSavedTime(state.notesAt, now)}. Read-only.`
}

/** Test hook: set the state without a worker. */
export function setOfflineForTest(next: OfflineState) {
  publish(next)
}
