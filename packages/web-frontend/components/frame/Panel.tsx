'use client'

import { useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  BookOpen,
  Clock,
  Database,
  Folder,
  Gauge,
  KeyRound,
  Server,
  Smartphone,
  Undo2,
  UserRound,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ComponentType, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { type BackupEntry, backupGlance } from '@/lib/backups'
import type { QuotaGlance } from '@/lib/frame/quota'
import { useApprovals } from '@/lib/hooks/use-asks'
import { useHosts } from '@/lib/hooks/use-hosts'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { useStatus } from '@/lib/hooks/use-status'
import {
  RECOVERY_QUERY_KEY,
  useStatusSessions,
} from '@/lib/hooks/use-status-sessions'
import { plural, rowButtons, type StatusRow } from '@/lib/status'
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
  { label: 'Quota', href: '/quota', where: 'wide', icon: Gauge },
  { label: 'Backups', href: '/backups', where: 'full', icon: Database },
  { label: 'Grants', href: '/grants', where: 'full', icon: KeyRound },
  {
    label: 'Machines',
    href: '/machines',
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

/** The session button a Status row offers (Resume for one that stopped, else Open), and what
 * pressing it does. Shared by the Worst problem card and Wide's Status rows. */
export function useRowSessionAction(top: StatusRow | undefined) {
  const sessions = useStatusSessions()
  const { view } = useStatus()
  const { hosts } = useHosts()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [note, setNote] = useState<string | null>(null)
  const session = top
    ? rowButtons(top, {
        here: view?.machine,
        hosts: new Set(hosts.map((host) => host.name)),
        sessions,
      }).buttons.find(
        (button) => button.kind === 'resume' || button.kind === 'open',
      )
    : undefined
  const sessionName = session ? sessions.names?.get(session.ref) : undefined
  const resume = async (id: string) => {
    try {
      const answer = await apiFetch<{
        results: { ok: boolean; reason: string | null }[]
      }>(
        '/api/recovery/resume',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        },
        'Couldn’t resume it',
      )
      const refused = answer.results.find((result) => !result.ok)
      if (refused) return setNote(refused.reason ?? 'Tether refused it.')
      router.push(`/?session=${encodeURIComponent(id)}`)
    } catch (error) {
      setNote((error as Error).message)
    } finally {
      await queryClient.invalidateQueries({ queryKey: RECOVERY_QUERY_KEY })
      await queryClient.invalidateQueries({ queryKey: ['terminal-sessions'] })
    }
  }
  const act = () => {
    if (!session) return
    if (session.kind === 'resume') void resume(session.ref)
    else router.push(`/?session=${encodeURIComponent(session.ref)}`)
  }
  const title = session
    ? session.kind === 'resume'
      ? `Resume “${sessionName ?? 'the session'}”, which stopped`
      : `Open “${sessionName ?? 'the session'}”`
    : undefined
  return { session, sessionName, note, act, title, names: sessions.names }
}

/** The one problem that matters most: a failure first, then Status's own ranking. */
export function QuotaBar({ glance }: { glance: QuotaGlance }) {
  const unknown = glance.left === null
  return (
    <li className={styles.quota} title={glance.meaning}>
      <div className={styles.quotaLine}>
        <b>{glance.name}</b>
        <span>{glance.line}</span>
      </div>
      <div
        className={styles.bar}
        data-unknown={unknown ? 'true' : undefined}
        role="img"
        aria-label={
          glance.state !== 'left'
            ? `${glance.name}: ${glance.answer}`
            : `${glance.name}: ${glance.left}% left${glance.gone === null ? '' : `, ${glance.gone}% of the way through the window`}`
        }
      >
        {!unknown && <span style={{ width: `${glance.left}%` }} />}
        {!unknown && glance.gone !== null && (
          <i className={styles.tick} style={{ left: `${glance.gone}%` }} />
        )}
      </div>
    </li>
  )
}

/** Every other place, one quiet list; a value only where it is read live. */
function Everything({ frame }: { frame: Frame | null }) {
  const { view } = useStatus()
  const { approvals } = useApprovals()
  const [backups, setBackups] = useState<BackupEntry[] | null>(null)
  useEffect(() => {
    let live = true
    fetch('/api/backups')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => live && setBackups(body?.entries ?? null))
      .catch(() => live && setBackups(null))
    return () => {
      live = false
    }
  }, [])
  const problems = view?.summary.problems
  const waiting = approvals?.state === 'ok' ? approvals.taps.length : undefined
  const glance: Record<string, { text: string; warn?: boolean } | undefined> = {
    Status:
      problems === undefined
        ? undefined
        : problems
          ? { text: plural(problems, 'problem'), warn: true }
          : { text: 'all healthy' },
    Backups: backups ? backupGlance(backups) : undefined,
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
        <div className={styles.capture}>
          <CaptureLauncher variant="row" />
        </div>
      </div>
    </section>
  )
}

/** The left side's Panel: the triage view. What waits on you, every session
 * by state (each state group carries its own count), then everything else. */
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
      <NeedsYouSection />
      <section className={styles.section} aria-label="Sessions">
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
      <Everything frame={frame} />
    </div>
  )
}
