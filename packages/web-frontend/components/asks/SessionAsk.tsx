'use client'

import { shortAgo } from '@aico/shared/time'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { openNeedsYou } from '@/lib/frame/needs-you-request'
import { openAsks, useOwnerAsks } from '@/lib/hooks/use-asks'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useFrame } from '../frame/FrameContext'
import { AskCard } from './AskCard'
import { useSentNote } from './ask-shared'

/** Ask ids are a session's short id; slots carry the full one. */
const sameSession = (a: string, b: string) => a.startsWith(b) || b.startsWith(a)

/** The open session's own question, under the session and above where you
 * type: one line that opens to the card on a desktop (open from the start
 * while the agent is waiting), and on the phone a line that opens the Needs
 * you sheet on that question. It takes room from the session rather than
 * covering it, so the session is a line or a few shorter while it shows. */
export function SessionAsk({
  sessionId,
  className,
}: {
  sessionId: string | null | undefined
  className?: string
}) {
  const isPhone = useMediaQuery('(max-width: 767px)')
  const { asks } = useOwnerAsks()
  const waiting = openAsks(asks)
  const mine = sessionId
    ? waiting.filter(
        (ask) => ask.session && sameSession(ask.session, sessionId),
      )
    : []
  const ask = mine[0]
  /** Folded or opened by hand, per question; else open while blocking. */
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  /** What the last Send said, once the question has left. */
  const [sent, setSent] = useSentNote()
  // A different session: what was sent there is not this one's news.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on switch
  useEffect(() => setSent(null), [sessionId])

  // A desktop whose side already lists the questions (Panel) does not show this one twice.
  const frame = useFrame()
  const listed = !isPhone && !!frame?.docked && frame.tier === 'panel'
  if (listed) return null
  if (!ask)
    return (
      <>
        {sent && (
          <p
            role="status"
            className={`lantern-session-ask truncate px-3 py-2 text-[13px] ${className ?? ''}`}
          >
            {sent}
          </p>
        )}
      </>
    )

  const now = Date.now()
  const open = !isPhone && (opened[ask.id] ?? ask.blocking)
  const others = waiting.length - 1
  const state = ask.blocking ? 'Waiting on you' : 'Asked you'
  const head = (
    <>
      <span aria-hidden="true" className="lantern-session-ask-dot" />
      <span className="flex-none" style={{ color: 'var(--bone)' }}>
        {state}
      </span>
      <span className="flex-none" style={{ color: 'var(--mist)' }}>
        · {shortAgo(ask.createdAt, now)}
      </span>
      {!open && <span className="min-w-0 flex-1 truncate">{ask.question}</span>}
      {open && <span className="flex-1" />}
      {mine.length > 1 && (
        <span className="flex-none" style={{ color: 'var(--mist)' }}>
          +{mine.length - 1} more
        </span>
      )}
    </>
  )

  return (
    <section
      aria-label="This session’s question"
      data-testid="session-ask"
      className={`lantern-session-ask ${className ?? ''}`}
    >
      {isPhone ? (
        <button
          type="button"
          className="lantern-session-ask-head"
          onClick={() => openNeedsYou(ask.id)}
          aria-label={`${state}: ${ask.question}. Answer`}
        >
          {head}
          <span className="flex-none" style={{ color: 'var(--lantern)' }}>
            Answer
          </span>
        </button>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="lantern-session-ask-head min-w-0 flex-1"
              aria-expanded={open}
              onClick={() => setOpened({ ...opened, [ask.id]: !open })}
              title={open ? 'Fold the question' : 'Show the question'}
            >
              {head}
              {open ? (
                <ChevronDown className="h-4 w-4 flex-none" strokeWidth={1.7} />
              ) : (
                <ChevronUp className="h-4 w-4 flex-none" strokeWidth={1.7} />
              )}
            </button>
            {others > 0 && (
              <button
                type="button"
                className="lantern-btn ghost small flex-none"
                onClick={() => openNeedsYou()}
              >
                See all {waiting.length}
              </button>
            )}
          </div>
          {open && (
            <div className="max-h-[40vh] max-w-[760px] overflow-y-auto overscroll-contain px-3 pt-1 pb-2.5">
              <AskCard ask={ask} now={now} onSent={setSent} inSession />
            </div>
          )}
        </>
      )}
    </section>
  )
}
