'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import { SESSION_REFRESH_MS } from './use-terminal-sessions'

/** What an ask wants back: `min` to `max` files, `hint` saying what. */
export interface WantsFiles {
  min: number
  max: number
  hint: string | null
}

/** A file the owner answered with; read it with `tether capture get ID`. */
export interface AnswerFile {
  id: string
  name: string
  mime: string
  size: number
  path: string | null
  host: string | null
}

/** A file or folder the asker attached for the owner to look at, as it is on
 * disk now; `missing` once moved or deleted. */
export interface AttachedFile {
  path: string
  name: string
  kind: 'file' | 'folder' | 'missing'
  /** Bytes, for a file; null for a folder or a missing file. */
  size: number | null
}

/** A question an agent put to the owner (tether docs/api-v1.md "Asks"). */
export interface OwnerAsk {
  id: string
  session: string | null
  requester: string | null
  question: string
  options: string[]
  recommended: number | null
  body: string | null
  command: string | null
  /** An https link the ask opens (an app notice's item); absent from an older Tether. */
  open?: string | null
  /** Set when an app filed it (a notice or a failed Status row): nobody to reply to. */
  origin?: 'notice' | 'status' | null
  share: string | null
  /** What the asker attached to look at (`tether ask create --file`); absent from an older Tether. */
  attached?: AttachedFile[]
  /** The files it wants; null or absent (an older Tether): none. */
  wantsFiles?: WantsFiles | null
  /** The files the owner answered with. */
  files?: AnswerFile[]
  blocking: boolean
  state: 'open' | 'answered' | 'done' | 'withdrawn'
  answer: string | null
  note: string | null
  /** `wake`: sent to the session; `pull`: the agent reads it when it checks. */
  delivery: 'wake' | 'pull' | null
  /** The session that launched the asker; absent from an older Tether. */
  launcher?: string | null
  /** The session the answer goes to (while open, where it would go now; once
   * answered, where it went); null: no session gets it, the agent reads it.
   * Absent (undefined) from an older Tether: say nothing. */
  answerTo?: string | null
  createdAt: number
  updatedAt: number
  answeredAt: number | null
  /** The linked host whose Tether holds the ask; absent: this computer's. */
  host?: string
  /** Set while that host's link is down: this is the last copy seen, not live. */
  peer?: { state: string; since: number; listedAt: number | null }
}

/** A host access request waiting for the owner; approved on its page with the security key, never here. */
export interface Approval {
  id: string
  title: string
  url: string
  expiresInS: number
}

export interface Approvals {
  state: 'ok' | 'unavailable'
  taps: Approval[]
}

const ASKS_KEY = ['owner-asks'] as const
const APPROVALS_KEY = ['owner-approvals'] as const
/** As often as the session list, so a new ask and its session's mark arrive together. */
const POLL_MS = SESSION_REFRESH_MS
/** Answered and closed asks stay in the Answered tab this long. */
const ANSWERED_KEPT_MS = 24 * 60 * 60 * 1000

function isAsk(value: unknown): value is OwnerAsk {
  if (!value || typeof value !== 'object') return false
  const ask = value as Record<string, unknown>
  return (
    typeof ask.id === 'string' &&
    /^[0-9a-f]{12}$/.test(ask.id) &&
    typeof ask.question === 'string' &&
    Array.isArray(ask.options) &&
    ask.options.every((option) => typeof option === 'string') &&
    typeof ask.blocking === 'boolean' &&
    ['open', 'answered', 'done', 'withdrawn'].includes(ask.state as string) &&
    typeof ask.createdAt === 'number'
  )
}

function parseAsks(value: unknown): OwnerAsk[] {
  const items = (value as { asks?: unknown } | null)?.asks
  if (!Array.isArray(items)) throw new Error('Invalid asks')
  return items.filter(isAsk)
}

/** Open asks first by age, oldest first: the owner answers in the order asked. */
export function openAsks(asks: readonly OwnerAsk[]): OwnerAsk[] {
  return asks
    .filter((ask) => ask.state === 'open')
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** What the open asks are: an agent's question, a notice an app filed (a
 * follow-up reminder), or a failed Status row. Only the first is a question. */
export interface AskCounts {
  questions: number
  notices: number
  checks: number
}

export function askCounts(asks: readonly OwnerAsk[]): AskCounts {
  const counts: AskCounts = { questions: 0, notices: 0, checks: 0 }
  for (const ask of asks) {
    if (ask.state !== 'open') continue
    if (ask.origin === 'notice') counts.notices += 1
    else if (ask.origin === 'status') counts.checks += 1
    else counts.questions += 1
  }
  return counts
}

/** The counts in words, each kind named for what it is: "2 agent questions,
 * 1 notice". Empty when nothing is open. */
export function askCountsParts(counts: AskCounts): string[] {
  const one = (n: number, singular: string, many = `${singular}s`) =>
    n > 0 ? `${n} ${n === 1 ? singular : many}` : null
  return [
    one(counts.questions, 'agent question'),
    one(counts.notices, 'notice'),
    one(counts.checks, 'failed check'),
  ].filter((part): part is string => part !== null)
}

/** Answered (not yet closed) and recently closed asks, newest first. */
export function answeredAsks(
  asks: readonly OwnerAsk[],
  now: number,
): OwnerAsk[] {
  return asks
    .filter(
      (ask) =>
        ask.state === 'answered' ||
        (ask.state === 'done' && now - ask.updatedAt < ANSWERED_KEPT_MS),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function useOwnerAsks() {
  const query = useQuery({
    queryKey: ASKS_KEY,
    queryFn: ({ signal }) =>
      apiFetch<unknown>('/api/asks', { signal, cache: 'no-store' }).then(
        parseAsks,
      ),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  })
  return {
    asks: query.data ?? [],
    /** The list has been read at least once (an empty list is a known zero). */
    known: query.data !== undefined,
    isLoading: query.isLoading,
    isError: query.isError && !query.data,
    refetch: query.refetch,
  }
}

export function useApprovals() {
  const query = useQuery({
    queryKey: APPROVALS_KEY,
    queryFn: ({ signal }) =>
      apiFetch<Approvals>('/api/approvals', { signal, cache: 'no-store' }),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
  return {
    approvals: query.data ?? null,
    known: query.data !== undefined,
    isLoading: query.isLoading,
  }
}

export type AskReply =
  | {
      kind: 'answer'
      option?: number
      text?: string
      note?: string
      /** Capture ids, in the order shown. */
      files?: string[]
      /** The owner chose to answer without the files the ask wanted. */
      skippedFiles?: boolean
    }
  | { kind: 'done' }

/** Answer or close an ask; the lists and the sessions (their needs-you mark) refresh. */
export function useAskReply() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reply }: { id: string; reply: AskReply }) => {
      const { kind, ...body } = reply
      return apiFetch<{ ask: OwnerAsk }>(
        `/api/asks/${id}/${kind}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        'Could not send it. Try again.',
      )
    },
    onSuccess: ({ ask }) => {
      client.setQueryData<OwnerAsk[]>(ASKS_KEY, (asks) =>
        asks?.map((item) => (item.id === ask.id ? ask : item)),
      )
      void client.invalidateQueries({ queryKey: ASKS_KEY })
      void client.invalidateQueries({ queryKey: ['terminal-sessions'] })
    },
  })
}
