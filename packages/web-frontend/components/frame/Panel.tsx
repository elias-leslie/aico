'use client'

import {
  Activity,
  BookOpen,
  Clock,
  Database,
  Folder,
  KeyRound,
  Server,
  Smartphone,
  StickyNote,
  Undo2,
  UserRound,
} from 'lucide-react'
import Link from 'next/link'
import type { ComponentType, ReactNode } from 'react'
import { useMemo } from 'react'
import {
  digestParts,
  digestStart,
  sinceText,
  spendText,
  useDigest,
  useLastLook,
} from '@/lib/frame/digest'
import { type QuotaGlance, quotaGlances, quotaTitle } from '@/lib/frame/quota'
import { useApprovals } from '@/lib/hooks/use-asks'
import { useClock } from '@/lib/hooks/use-clock'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { useStatus } from '@/lib/hooks/use-status'
import { popOutNotes } from '@/lib/notes-window'
import { plural, reason, type StatusRow, WORD } from '@/lib/status'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { NeedsYouSection } from '../asks/NeedsYou'
import { CaptureLauncher } from '../capture/CaptureLauncher'
import { SessionList } from '../SessionList'
import { type Frame, useFrame } from './FrameContext'
import styles from './Panel.module.css'

/** Where each place opens: Wide beside the session for the daily ones, Full for the rest. */
type Where = 'wide' | 'full'

interface Place {
  label: string
  href: string
  where: Where
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
}

const PLACES: readonly Place[] = [
  { label: 'Status', href: '/status', where: 'wide', icon: Activity },
  { label: 'Projects', href: '/projects', where: 'wide', icon: Folder },
  { label: 'Recent', href: '/history', where: 'wide', icon: Clock },
  { label: 'Backups', href: '/backups', where: 'full', icon: Database },
  { label: 'Grants', href: '/grants', where: 'full', icon: KeyRound },
  {
    label: 'Machines',
    href: '/status?kind=machine',
    where: 'full',
    icon: Server,
  },
  { label: 'Recovery', href: '/recovery', where: 'full', icon: Undo2 },
  { label: 'Logins', href: '/logins', where: 'full', icon: UserRound },
  { label: 'Context', href: '/agents', where: 'full', icon: BookOpen },
  { label: 'Phone app', href: '/app', where: 'full', icon: Smartphone },
]

function SectionHead({
  title,
  count,
  more,
}: {
  title: string
  count?: number | string
  more?: ReactNode
}) {
  return (
    <div className="lantern-sec">
      <h2>{title}</h2>
      {count !== undefined && <span className="n">{count}</span>}
      {more && <span className={styles.more}>{more}</span>}
    </div>
  )
}

function MoreLink({
  frame,
  href,
  where = 'wide',
  children,
}: {
  frame: Frame | null
  href: string
  where?: Where
  children: ReactNode
}) {
  return (
    <Link
      href={href}
      className={styles.moreLink}
      onClick={(event) => {
        if (!frame) return
        event.preventDefault()
        frame.open(href, where)
      }}
    >
      {children}
    </Link>
  )
}

/** The line at the top: what happened since this device last looked. */
function SinceLine({ frame }: { frame: Frame | null }) {
  const lastLook = useLastLook()
  const now = useClock(60_000)
  // The start is fixed for the visit; the clock only words it.
  const start = useMemo(() => digestStart(lastLook, Date.now()), [lastLook])
  const { digest, loading, failed, stale, refetch } = useDigest(start)
  const head = sinceText(start, now)
  if (loading)
    return (
      <p className={styles.since} role="status">
        <span className={styles.sinceHead}>{head}</span>
        Checking what happened…
      </p>
    )
  if (failed || !digest)
    return (
      <p className={styles.since} role="status">
        <span className={styles.sinceHead}>{head}</span>
        Couldn’t read what happened.{' '}
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => void refetch()}
        >
          Try again
        </button>
      </p>
    )
  const parts = digestParts(digest)
  const spend = spendText(digest)
  return (
    <div
      className={styles.since}
      data-testid="since-line"
      data-stale={stale ? 'true' : undefined}
    >
      <p>
        <span className={styles.sinceHead}>{head}</span>
        <span className={digest.failed > 0 ? styles.bad : undefined}>
          {parts.finished}
        </span>
        {parts.rest.length > 0 && `, ${parts.rest.join(', ')}`}
        {parts.quiet && '; nothing else'}
        {spend && ` · ${spend}`}
        {stale && ' · as of the last read'}
      </p>
      {parts.unread && <p className={styles.unread}>{parts.unread}</p>}
      <MoreLink frame={frame} href="/today">
        See the day
      </MoreLink>
    </div>
  )
}

/** The one problem that matters most, from Status's own ranking. */
function WorstProblem({ frame }: { frame: Frame | null }) {
  const { view, loading, failed, stale } = useStatus()
  const problems = view?.summary.problems
  const top: StatusRow | undefined = view?.summary.top[0]
  return (
    <section className={styles.section} aria-label="Worst problem">
      <SectionHead
        title="Worst problem"
        more={
          problems && problems > 1 ? (
            <MoreLink frame={frame} href="/status">
              See all {problems} in Status
            </MoreLink>
          ) : null
        }
      />
      {loading ? (
        <p className={styles.note}>Checking Status…</p>
      ) : failed ? (
        <p className={styles.note}>Status couldn’t be read.</p>
      ) : !view || problems === 0 || !top ? (
        <p className={styles.note}>
          {stale ? 'As of the last read: no problems.' : 'No problems.'}
        </p>
      ) : (
        <div className={styles.worst} data-stale={stale ? 'true' : undefined}>
          <div className={styles.worstMeta}>
            <span
              className="lantern-chip"
              data-tone={top.shown === 'failed' ? 'bad' : 'wait'}
            >
              {WORD[top.shown]}
            </span>
            <span>{top.machine}</span>
          </div>
          <h3>{top.what}</h3>
          <p>{reason(top) || top.meaning}</p>
          <MoreLink frame={frame} href="/status">
            Open Status
          </MoreLink>
        </div>
      )}
    </section>
  )
}

function QuotaBar({ glance }: { glance: QuotaGlance }) {
  const out = glance.state === 'used_up'
  const used =
    glance.state === 'left' && glance.left !== null
      ? 100 - glance.left
      : out
        ? 100
        : null
  const sentence = glance.meaning.split(/\.(?:\s|$)/)[0] ?? glance.meaning
  return (
    <li className={styles.quota} title={glance.meaning}>
      <div className={styles.quotaLine}>
        <b>{glance.name}</b>
        <span>{sentence}</span>
      </div>
      <div
        className={styles.bar}
        role="img"
        aria-label={
          used === null
            ? `${glance.name}: not known`
            : `${glance.name}: ${used}% used`
        }
      >
        {used !== null && (
          <span
            data-out={out ? 'true' : undefined}
            style={{ width: `${used}%` }}
          />
        )}
      </div>
    </li>
  )
}

function Quota({ frame }: { frame: Frame | null }) {
  const { view, loading, failed, stale } = useStatus()
  const glances = quotaGlances(view?.rows ?? [])
  return (
    <section className={styles.section} aria-label="Quota">
      <SectionHead
        title="Quota"
        more={
          <MoreLink frame={frame} href="/status?q=usage">
            Spend by day
          </MoreLink>
        }
      />
      {loading ? (
        <p className={styles.note}>Checking quota…</p>
      ) : failed ? (
        <p className={styles.note}>Quota couldn’t be read.</p>
      ) : glances.length === 0 ? (
        <p className={styles.note}>No quota reports yet.</p>
      ) : (
        <ul
          className={styles.quotas}
          title={quotaTitle(glances)}
          data-stale={stale ? 'true' : undefined}
        >
          {glances.map((glance) => (
            <QuotaBar key={glance.id} glance={glance} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** Every other place, one quiet list; a value only where it is read live. */
function Everything({ frame }: { frame: Frame | null }) {
  const { view } = useStatus()
  const { approvals } = useApprovals()
  const problems = view?.summary.problems
  const waiting = approvals?.state === 'ok' ? approvals.taps.length : undefined
  const glance: Record<string, { text: string; warn?: boolean } | undefined> = {
    Status:
      problems === undefined
        ? undefined
        : problems
          ? { text: plural(problems, 'problem'), warn: true }
          : { text: 'all healthy' },
    Grants: waiting ? { text: `${waiting} waiting`, warn: true } : undefined,
  }
  return (
    <section className={styles.section} aria-label="Everything else">
      <SectionHead title="Everything else" />
      <div className={styles.else}>
        {PLACES.map((place) => {
          const Icon = place.icon
          const value = glance[place.label]
          return (
            <Link
              key={place.label}
              href={place.href}
              className={styles.place}
              onClick={(event) => {
                if (!frame) return
                event.preventDefault()
                frame.open(place.href, place.where)
              }}
            >
              <Icon className="h-4 w-4" strokeWidth={1.7} />
              <span>
                <span className={styles.label}>{place.label}</span>
                {value && (
                  <span
                    className={styles.value}
                    data-warn={value.warn ? 'true' : undefined}
                  >
                    {value.text}
                  </span>
                )}
              </span>
            </Link>
          )
        })}
        <button
          type="button"
          className={styles.place}
          onClick={() => {
            if (!popOutNotes('/notes')) window.location.assign('/notes')
          }}
          title="Notes open in their own window"
        >
          <StickyNote className="h-4 w-4" strokeWidth={1.7} />
          <span>
            <span className={styles.label}>Notes</span>
            <span className={styles.value}>own window</span>
          </span>
        </button>
        <div className={styles.capture}>
          <CaptureLauncher variant="row" />
        </div>
      </div>
    </section>
  )
}

/** The left side's Panel: the triage view. What waits on you, every session
 * by state, the worst problem, quota, then everything else. */
export function Panel({
  slots,
  currentId,
  onSelect,
}: {
  slots: Array<TerminalSlot | PaneSlot>
  currentId?: string
  onSelect: (slot: TerminalSlot | PaneSlot) => void
}) {
  const frame = useFrame()
  const attention = useSessionAttention()
  return (
    <div className={styles.panel} data-testid="session-sidebar">
      <SinceLine frame={frame} />
      <NeedsYouSection />
      <section className={styles.section} aria-label="Sessions">
        <SectionHead title="Sessions" count={slots.length} />
        <nav
          aria-label="Sessions"
          data-testid="session-list"
          className={styles.sessions}
        >
          {slots.length === 0 ? (
            <p className={styles.note}>
              No sessions yet. New session starts one.
            </p>
          ) : (
            <SessionList
              slots={slots}
              currentId={currentId}
              attention={attention}
              onSelect={onSelect}
            />
          )}
        </nav>
      </section>
      <WorstProblem frame={frame} />
      <Quota frame={frame} />
      <Everything frame={frame} />
    </div>
  )
}
