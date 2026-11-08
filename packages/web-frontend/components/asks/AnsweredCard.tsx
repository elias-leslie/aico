'use client'

import { shortAgo } from '@aico/shared/time'
import { type OwnerAsk, useAskReply } from '@/lib/hooks/use-asks'
import { shortWhen } from '@/lib/short-when'
import { plural } from '@/lib/status'
import { AnsweredFiles } from './AskFiles'
import { askTitle, Meta, OpenSession, useAsker } from './ask-shared'

/** How the answer travels, in the owner's words. */
function deliveryText(ask: OwnerAsk, replied: boolean): string {
  if (ask.state === 'done')
    return replied ? 'Closed.' : 'Closed without an answer from you.'
  if (ask.state === 'withdrawn') return 'The agent withdrew it.'
  if (ask.delivery === 'wake')
    return 'Sent to the session. The agent gets it once it is idle.'
  return 'Saved. The agent reads it when it checks; this session can’t be messaged.'
}

export function AnsweredCard({ ask, now }: { ask: OwnerAsk; now: number }) {
  const asker = useAsker(ask)
  const reply = useAskReply()
  const replied = !!(ask.answer || ask.note || ask.files?.length)
  return (
    <li data-testid="answered-card" className="lantern-ask">
      <Meta>
        <span className="min-w-0 truncate" style={{ color: 'var(--bone)' }}>
          {asker.name}
        </span>
        <span aria-hidden="true">·</span>
        <span
          className="whitespace-nowrap"
          title={shortWhen(ask.answeredAt ?? ask.updatedAt)}
        >
          {shortAgo(ask.answeredAt ?? ask.updatedAt, now)}
        </span>
      </Meta>
      <p className="mb-1 font-semibold" style={{ overflowWrap: 'anywhere' }}>
        {askTitle(ask)}
      </p>
      {replied && (
        <p className="text-[13.5px]" style={{ overflowWrap: 'anywhere' }}>
          {ask.answer ? (
            <>
              You answered <b>{ask.answer}</b>
            </>
          ) : ask.files?.length ? (
            `You sent ${plural(ask.files.length, 'file')}`
          ) : (
            'You replied'
          )}
          {ask.note ? `: “${ask.note}”` : ''}
          {ask.answer && ask.files?.length
            ? ` (${plural(ask.files.length, 'file')})`
            : ''}
        </p>
      )}
      <AnsweredFiles files={ask.files ?? []} />
      <p className="mt-1 text-[12.5px]" style={{ color: 'var(--mist)' }}>
        {deliveryText(ask, replied)}
      </p>
      {ask.state === 'answered' && (
        <div className="mt-1.5 flex items-center gap-1">
          <button
            type="button"
            className="lantern-btn ghost small -ml-2.5"
            disabled={reply.isPending}
            onClick={() =>
              reply.mutate({ id: ask.id, reply: { kind: 'done' } })
            }
            title="Close it here if the agent already handled it"
          >
            Clear
          </button>
          <OpenSession sessionId={asker.sessionId} />
        </div>
      )}
    </li>
  )
}
