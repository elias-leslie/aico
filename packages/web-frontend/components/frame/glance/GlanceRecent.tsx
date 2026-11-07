'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useId, useState } from 'react'
import { HistoryTranscript } from '@/components/history/HistoryTranscript'
import { useLiveSessions } from '@/lib/frame/live'
import {
  agoAt,
  clock,
  countOf,
  type HistorySession,
  STANDING_CHIP,
  STANDING_TEXT,
  shortFolder,
  standing,
  TOOLS,
  tokenLine,
  toolName,
} from '@/lib/history'
import { useClock } from '@/lib/hooks/use-clock'
import { useHistory } from '@/lib/hooks/use-history'
import { useSessionLabels } from '@/lib/hooks/use-session-labels'
import { usePopoverClose } from '../RailPopover'
import { useWiden } from '../Widen'
import notes from './Glance.module.css'
import styles from './GlanceRecent.module.css'
import type { GlanceHead } from './glance-types'

const nameOf = (session: HistorySession) =>
  session.project ?? (shortFolder(session.cwd) || 'Session')

const startOfDay = (ms: number) => {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Whether a session belongs to today: it ended (or, if it has not, started) since midnight. */
const isToday = (session: HistorySession, day: number) =>
  (session.endedAt ?? session.startedAt ?? 0) >= day

/** Recent for the section's collapsed row: how many sessions today, or why that is not known. */
export function useRecentGlance(): GlanceHead {
  const now = useClock(60_000)
  const history = useHistory('')
  if (!history.items)
    return history.loading
      ? { value: 'Checking…', tone: null }
      : { value: 'Couldn’t read', tone: 'failed' }
  const day = startOfDay(now)
  const today = history.items.filter(
    (session) => !session.test && isToday(session, day),
  ).length
  return { value: `${today} today`, tone: null }
}

/** A session's whole transcript inline, in a wider side while it is open. */
function Transcript({ id }: { id: string }) {
  useWiden(true)
  return (
    <div className={styles.transcript}>
      <HistoryTranscript id={id} embedded />
    </div>
  )
}

function Detail({
  session,
  liveSession,
}: {
  session: HistorySession
  liveSession: string | null
}) {
  const [reading, setReading] = useState(false)
  const closePopout = usePopoverClose()
  return (
    <div className={styles.detail}>
      <dl className={styles.facts}>
        <dt>Tool</dt>
        <dd>
          {toolName(session.tool)} · {session.model ?? 'model not recorded'}
        </dd>
        <dt>Project</dt>
        <dd>{session.project ?? 'not recorded'}</dd>
        {session.cwd && (
          <>
            <dt>Folder</dt>
            <dd className={styles.mono}>{session.cwd}</dd>
          </>
        )}
        <dt>Time</dt>
        <dd>
          {clock(session.startedAt)} to {clock(session.endedAt)}
        </dd>
        <dt>Work</dt>
        <dd>
          {countOf(session.toolCalls, 'tool call')} ·{' '}
          {countOf(session.filesWritten, 'file')} written
        </dd>
        <dt>Tokens</dt>
        <dd>{tokenLine(session.tokens)}</dd>
      </dl>
      {session.doing && <p className={styles.doing}>{session.doing}</p>}
      <div className={styles.acts}>
        {liveSession && (
          <Link
            className={`lantern-btn small primary ${styles.open}`}
            href={`/?session=${encodeURIComponent(liveSession)}`}
            onClick={() => closePopout?.()}
          >
            Open session
          </Link>
        )}
        <button
          type="button"
          className="lantern-btn small"
          aria-expanded={reading}
          onClick={() => setReading((value) => !value)}
        >
          {reading ? 'Hide transcript' : 'Show transcript'}
        </button>
      </div>
      {reading && <Transcript id={session.id} />}
    </div>
  )
}

function SessionRow({
  session,
  label,
  now,
  state,
  liveSession,
  open,
  onToggle,
}: {
  session: HistorySession
  label: string
  now: number
  state: ReturnType<typeof standing>
  liveSession: string | null
  open: boolean
  onToggle: () => void
}) {
  const inside = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className={styles.item}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        aria-controls={inside}
        onClick={onToggle}
      >
        <span className={`status-chip ${STANDING_CHIP[state]}`}>
          {STANDING_TEXT[state]}
        </span>
        <span className={styles.text}>
          <span className={styles.title}>{label}</span>
          <span className={styles.line}>
            {nameOf(session)} · {toolName(session.tool)} ·{' '}
            {agoAt(session.endedAt, now)}
          </span>
        </span>
        <Chevron
          className={`h-3.5 w-3.5 ${styles.chevron}`}
          strokeWidth={1.7}
          aria-hidden="true"
        />
      </button>
      <div id={inside}>
        {open && <Detail session={session} liveSession={liveSession} />}
      </div>
    </li>
  )
}

/** Every recent session: state chip, name, project, agent and how long ago. A row opens in place for its
 * totals, to switch to it when it is running, and to read its transcript. Test runs wait behind a toggle. */
export function GlanceRecent() {
  const now = useClock(30_000)
  const live = useLiveSessions()
  const labelOf = useSessionLabels()
  const [tool, setTool] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [showTests, setShowTests] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const history = useHistory(tool)
  const items = history.items
  if (!items)
    return (
      <p className={notes.note} role={history.loading ? 'status' : 'alert'}>
        {history.loading
          ? 'Loading recent sessions…'
          : 'Recent sessions couldn’t be read.'}
        {history.failed && (
          <button
            type="button"
            className={`lantern-btn small ${styles.retry}`}
            disabled={history.refreshing}
            onClick={() => void history.refetch()}
          >
            {history.refreshing ? 'Trying…' : 'Try again'}
          </button>
        )}
      </p>
    )
  const liveOf = (session: HistorySession) =>
    [...live.bySession.values()].find(
      (item) => item.conversation === session.id,
    )
  const tests = items.filter((session) => session.test).length
  const visible = showTests ? items : items.filter((session) => !session.test)
  const rows = visible.map((session) => ({
    session,
    live: liveOf(session),
  }))
  const day = startOfDay(now)
  const shown = onlyFailed
    ? rows.filter((row) => standing(row.session, now, row.live) === 'failed')
    : rows
  return (
    <div data-stale={history.stale ? 'true' : undefined}>
      <div className={styles.filters}>
        <select
          className={`status-select${tool ? ' set' : ''} ${styles.select}`}
          aria-label="Tool"
          value={tool}
          onChange={(event) => setTool(event.target.value)}
        >
          <option value="">All tools</option>
          {TOOLS.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="lantern-btn ghost small"
          aria-pressed={onlyFailed}
          onClick={() => setOnlyFailed((value) => !value)}
        >
          Failed only
        </button>
        {tests > 0 && (
          <button
            type="button"
            className="lantern-btn ghost small"
            aria-pressed={showTests}
            onClick={() => setShowTests((value) => !value)}
          >
            {showTests
              ? 'Hide test runs'
              : `${countOf(tests, 'test run')} hidden · Show`}
          </button>
        )}
      </div>
      {history.stale && (
        <p className={notes.note} role="status">
          Showing the list from {clock(history.readAt)}. Couldn’t refresh it.
          <button
            type="button"
            className={`lantern-btn small ${styles.retry}`}
            disabled={history.refreshing}
            onClick={() => void history.refetch()}
          >
            {history.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </p>
      )}
      {shown.length === 0 ? (
        <p className={notes.note}>
          {onlyFailed
            ? 'No failed sessions.'
            : tool
              ? `No ${toolName(tool)} sessions yet.`
              : tests > 0 && !showTests
                ? `No sessions yet; ${countOf(tests, 'test run')} hidden.`
                : 'No sessions yet.'}
        </p>
      ) : (
        [
          {
            name: 'Today',
            rows: shown.filter((row) => isToday(row.session, day)),
          },
          {
            name: 'Earlier',
            rows: shown.filter((row) => !isToday(row.session, day)),
          },
        ]
          .filter((group) => group.rows.length > 0)
          .map((group) => (
            <section key={group.name} aria-label={group.name}>
              <h3 className={styles.group}>{group.name}</h3>
              <ul className={styles.list}>
                {group.rows.map(({ session, live: owner }) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    label={labelOf(session)}
                    now={now}
                    state={standing(session, now, owner)}
                    liveSession={owner?.session ?? null}
                    open={openId === session.id}
                    onToggle={() =>
                      setOpenId((current) =>
                        current === session.id ? null : session.id,
                      )
                    }
                  />
                ))}
              </ul>
            </section>
          ))
      )}
    </div>
  )
}
