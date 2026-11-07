'use client'

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { OwnerAsk } from '@/lib/hooks/use-asks'
import { useTerminalSessions } from '@/lib/hooks/use-terminal-sessions'

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 py-2 text-[13px]" style={{ color: 'var(--mist)' }}>
      {children}
    </p>
  )
}

/** A session's name from the list the app already has, else null. */
export function useSessionName(): (id: string) => string | null {
  const { sessions } = useTerminalSessions({ includeDetached: true })
  return useCallback(
    (id: string) => sessions?.find((item) => item.id === id)?.name ?? null,
    [sessions],
  )
}

/** Who asked: the session's name, else the requester's label. */
export function useAsker(ask: OwnerAsk): {
  name: string
  sessionId: string | null
} {
  const nameOf = useSessionName()
  return useMemo(() => {
    const name = ask.session ? nameOf(ask.session) : null
    if (ask.session && name !== null) return { name, sessionId: ask.session }
    if (ask.session) return { name: 'An ended session', sessionId: null }
    return { name: ask.requester ?? 'An agent', sessionId: null }
  }, [ask.session, ask.requester, nameOf])
}

/** The question as the owner reads it: a notice's ask ends with a short id that only keeps
 * two notices from merging in Tether. */
export function askTitle(ask: OwnerAsk): string {
  return ask.origin === 'notice'
    ? ask.question.replace(/\s*\(#[0-9a-f]{6}\)$/, '') || ask.question
    : ask.question
}

export function Meta({ children }: { children: ReactNode }) {
  return (
    <div
      className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[12px]"
      style={{ color: 'var(--mist)' }}
    >
      {children}
    </div>
  )
}

export function OpenSession({
  sessionId,
  onOpen,
}: {
  sessionId: string | null
  onOpen?: () => void
}) {
  const router = useRouter()
  if (!sessionId) return null
  return (
    <button
      type="button"
      className="lantern-btn small"
      onClick={() => {
        const params = new URLSearchParams(window.location.search)
        params.delete('ask')
        params.set('session', sessionId)
        router.push(`?${params.toString()}`, { scroll: false })
        onOpen?.()
      }}
    >
      Open session
    </button>
  )
}

/** What the last Send said, until the owner moves on (it clears itself after a few seconds). */
export function useSentNote() {
  const [sent, setSent] = useState<string | null>(null)
  useEffect(() => {
    if (!sent) return
    const timer = window.setTimeout(() => setSent(null), 8000)
    return () => window.clearTimeout(timer)
  }, [sent])
  return [sent, setSent] as const
}

/** The notes that stand in for the questions while the server is down, loading or failed; otherwise the questions. */
export function AsksState({
  unreachable,
  isLoading,
  isError,
  refetch,
  children,
}: {
  unreachable: boolean
  isLoading: boolean
  isError: boolean
  refetch: () => unknown
  children: ReactNode
}) {
  if (unreachable) return <Note>Questions show here once it answers.</Note>
  if (isLoading) return <Note>Loading questions…</Note>
  if (isError)
    return (
      <Note>
        Couldn’t load questions.{' '}
        <button
          type="button"
          className="lantern-btn ghost small"
          onClick={() => void refetch()}
        >
          Try again
        </button>
      </Note>
    )
  return <>{children}</>
}
