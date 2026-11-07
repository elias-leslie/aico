'use client'

// "While you were away": what happened since this device last looked. The
// server counts it (`/api/digest`, the same counts the morning phone push
// uses); the last look is kept per device, in this browser.

import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { apiFetch } from '../api-fetch'
import { at, plural } from '../status'

export interface Digest {
  since: number
  generatedAt: number
  finished: number
  failed: number
  stuck: { quiet: number; waiting: number }
  asks: number
  problems: { count: number; failed: number }
  spend: {
    sinceDay: string
    items: { provider: string; credits: number }[]
  } | null
  /** Parts the server could not read: their numbers are unknown, not zero. */
  unavailable: string[]
}

const LAST_LOOK_KEY = 'aico:last-look'
/** Without a last look (a new device), the digest covers this long. */
const FIRST_LOOK_MS = 12 * 60 * 60 * 1000
/** Away this long counts as a break: the next look starts a new digest. */
const BREAK_MS = 10 * 60 * 1000
const BEAT_MS = 60_000

interface LookState {
  /** When the digest starts: the last look before this visit. null: a new device. */
  since: number | null
}

let look: LookState = { since: null }
let started = false
let hiddenAt = 0
const listeners = new Set<() => void>()

function read(): number | null {
  try {
    const raw = Number(localStorage.getItem(LAST_LOOK_KEY))
    return Number.isFinite(raw) && raw > 0 ? raw : null
  } catch {
    return null
  }
}

function write(ms: number) {
  try {
    localStorage.setItem(LAST_LOOK_KEY, String(ms))
  } catch {
    // Storage blocked: the digest then restarts with each load.
  }
}

function emit() {
  for (const listener of listeners) listener()
}

/** Remember when this device last looked; a long break starts a new digest. */
function start() {
  if (started || typeof window === 'undefined') return
  started = true
  look = { since: read() }
  write(Date.now())
  window.setInterval(() => {
    if (document.visibilityState === 'visible') write(Date.now())
  }, BEAT_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      write(hiddenAt)
      return
    }
    if (hiddenAt && Date.now() - hiddenAt > BREAK_MS) {
      look = { since: hiddenAt }
      emit()
    }
    hiddenAt = 0
  })
}

export function useLastLook(): number | null {
  start()
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => look.since,
    () => null,
  )
}

/** Where the digest starts: the last look, else the first-visit window. */
export function digestStart(lastLook: number | null, now: number): number {
  return lastLook ?? now - FIRST_LOOK_MS
}

const DIGEST_POLL_MS = 60_000

export function useDigest(since: number) {
  // Minute-sized steps keep the query key (and the request) steady.
  const key = Math.floor(since / 60_000)
  const query = useQuery({
    queryKey: ['digest', key],
    queryFn: () =>
      apiFetch<Digest>(
        `/api/digest?since=${key * 60_000}`,
        { cache: 'no-store' },
        'Couldn’t read what happened',
      ),
    refetchInterval: DIGEST_POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  const digest = query.data ?? null
  return {
    digest,
    loading: query.isPending,
    failed: !digest && query.isError,
    stale: !!digest && query.isError,
    refetch: query.refetch,
  }
}

export interface DigestParts {
  /** "3 finished, 1 of them failed", "nothing finished": the line that leads. */
  finished: string
  /** Plain pieces after it: stuck sessions, new questions still waiting. */
  rest: string[]
  /** What it could not read, in words, or null. */
  unread: string | null
  /** Nothing happened (and everything was read). */
  quiet: boolean
}

const UNREAD_WORD: Record<string, string> = {
  history: 'finished sessions',
  sessions: 'running sessions',
  asks: 'questions',
  status: 'problems',
  spend: 'spend',
}

/** The digest in the owner's words. A part that couldn't be read is never a zero. */
export function digestParts(digest: Digest): DigestParts {
  const skipped = (name: string) => digest.unavailable.includes(name)
  const finished = skipped('history')
    ? 'finished sessions not read'
    : digest.finished === 0
      ? 'nothing finished'
      : digest.failed > 0
        ? `${digest.finished} finished, ${digest.failed === digest.finished ? (digest.failed === 1 ? 'and it failed' : 'all failed') : `${digest.failed} of them failed`}`
        : `${digest.finished} finished`
  const rest: string[] = []
  const stuck = digest.stuck.quiet + digest.stuck.waiting
  if (!skipped('sessions') && stuck > 0)
    rest.push(
      `${[
        digest.stuck.waiting ? `${digest.stuck.waiting} waiting` : null,
        digest.stuck.quiet ? `${digest.stuck.quiet} quiet` : null,
      ]
        .filter(Boolean)
        .join(', ')} (stuck)`,
    )
  if (!skipped('asks') && digest.asks > 0)
    rest.push(`${plural(digest.asks, 'new question')} waiting`)
  const unread = digest.unavailable.length
    ? `Couldn’t read ${digest.unavailable.map((name) => UNREAD_WORD[name] ?? name).join(', ')}.`
    : null
  const quiet =
    digest.unavailable.length === 0 &&
    digest.finished === 0 &&
    stuck === 0 &&
    digest.asks === 0
  return { finished, rest, unread, quiet }
}

/** "Since 11:40 PM", "Since yesterday 11:40 PM"; for a device that never
 * looked there is no moment to name, so it says how far back it counts. */
export function sinceText(
  since: number,
  now: number,
  neverLooked = false,
): string {
  return neverLooked
    ? `Past ${Math.round(FIRST_LOOK_MS / 3_600_000)} hours`
    : `Since ${at(since, now)}`
}

/** The credits line: "Codex 1.5K credits". Null when none were spent or it wasn't read. */
export function spendText(digest: Digest): string | null {
  if (!digest.spend || digest.spend.items.length === 0) return null
  return digest.spend.items
    .map(
      (item) =>
        `${item.provider.charAt(0).toUpperCase()}${item.provider.slice(1)} ${creditCount(item.credits)} credits`,
    )
    .join(', ')
}

function creditCount(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000)}K`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(Math.round(value))
}
