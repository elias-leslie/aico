'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import { SESSION_REFRESH_MS } from './use-terminal-sessions'

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
  share: string | null
  blocking: boolean
  state: 'open' | 'answered' | 'done' | 'withdrawn'
  answer: string | null
  note: string | null
  /** `wake`: sent to the session; `pull`: the agent reads it when it checks. */
  delivery: 'wake' | 'pull' | null
  createdAt: number
  updatedAt: number
  answeredAt: number | null
}

/** A Nightshift tap waiting for the owner; approved there, never here. */
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
export const ANSWERED_KEPT_MS = 24 * 60 * 60 * 1000

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

export function parseAsks(value: unknown): OwnerAsk[] {
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
    isLoading: query.isLoading,
  }
}

export type AskReply =
  | { kind: 'answer'; option?: number; text?: string; note?: string }
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
