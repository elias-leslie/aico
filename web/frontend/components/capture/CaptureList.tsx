'use client'

import Link from 'next/link'
import type { Capture } from '@/lib/api/captures'
import { formatAge } from '@/lib/attention'
import {
  firstLine,
  formatBytes,
  formatWhen,
  statusWord,
} from '@/lib/capture-format'
import { useCaptures } from '@/lib/hooks/use-captures'
import { CaptureThumb } from './CaptureThumb'

function Note({
  children,
  tone = 'mist',
  testId,
}: {
  children: React.ReactNode
  tone?: 'mist' | 'beacon'
  testId?: string
}) {
  return (
    <p
      role="status"
      data-testid={testId}
      className="px-1 py-3 text-[13px]"
      style={{ color: tone === 'beacon' ? 'var(--beacon)' : 'var(--mist)' }}
    >
      {children}
    </p>
  )
}

const RetryButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    className="inline-flex min-h-11 items-center underline underline-offset-2 md:min-h-0"
    style={{ color: 'var(--lantern)' }}
    onClick={onClick}
  >
    Try again
  </button>
)

function Row({ capture }: { capture: Capture }) {
  const heading = capture.caption || firstLine(capture.text)
  return (
    <li>
      <Link
        href={`/captures?id=${capture.id}`}
        data-testid="capture-item"
        className="flex items-center gap-3 rounded-lg px-1 py-2 outline-none hover:bg-[var(--paper)] focus-visible:outline-2 focus-visible:outline-[var(--lantern)]"
      >
        <CaptureThumb capture={capture} />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-[14px]"
            style={{ color: 'var(--bone)' }}
          >
            {heading || capture.name}
          </span>
          <span
            className="block truncate text-[12px]"
            style={{ color: 'var(--mist)' }}
          >
            {heading ? `${capture.name} · ` : ''}
            {formatBytes(capture.size)} · {formatWhen(capture.createdAt)}
          </span>
        </span>
        <span
          className="flex-none text-[11px]"
          style={{
            color:
              capture.status === 'failed'
                ? 'var(--term-error-text)'
                : 'var(--mist)',
          }}
        >
          {statusWord(capture.status)}
        </span>
      </Link>
    </li>
  )
}

/** Every capture, newest first, with an honest state for loading, empty,
 * failed and stale. */
export function CaptureList() {
  const list = useCaptures()

  if (list.isLoading) return <Note>Loading captures…</Note>
  if (list.isError)
    return (
      <Note testId="captures-failed">
        Couldn&apos;t load captures{list.error ? `: ${list.error}` : ''}.{' '}
        <RetryButton onClick={list.refetch} />
      </Note>
    )
  return (
    <>
      {list.isStale && (
        <Note tone="beacon" testId="captures-stale">
          Couldn&apos;t refresh. This is the list from{' '}
          {formatAge(Date.now() - list.updatedAt)} ago.{' '}
          <RetryButton onClick={list.refetch} />
        </Note>
      )}
      {list.captures.length === 0 ? (
        <Note testId="captures-empty">
          No captures yet. Tap Capture to send a photo or a file.
        </Note>
      ) : (
        <>
          <ul aria-label="Captures">
            {list.captures.map((capture) => (
              <Row key={capture.id} capture={capture} />
            ))}
          </ul>
          {list.hasMore ? (
            <button
              type="button"
              className="lantern-btn mx-auto mt-3 min-h-11"
              disabled={list.loadingMore}
              onClick={list.loadMore}
            >
              {list.loadingMore ? 'Loading…' : 'Show older'}
            </button>
          ) : (
            <Note>
              {list.total === 1 ? '1 capture' : `${list.total} captures`}
            </Note>
          )}
        </>
      )}
    </>
  )
}
