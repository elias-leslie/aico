import { useQueryClient } from '@tanstack/react-query'
import { BookOpen, KeyRound, Smartphone, Undo2, UserRound } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ComponentType, ReactNode } from 'react'
import { useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { useApprovals } from '@/lib/hooks/use-asks'
import { useHosts } from '@/lib/hooks/use-hosts'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { useStatus } from '@/lib/hooks/use-status'
import {
  RECOVERY_QUERY_KEY,
  useStatusSessions,
} from '@/lib/hooks/use-status-sessions'
import { rowButtons, type StatusRow } from '@/lib/status'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { NeedsYouSection } from '../asks/NeedsYou'
import { CaptureLauncher } from '../capture/CaptureLauncher'
import { SessionList } from '../SessionList'
import { type Frame, useFrame } from './FrameContext'
import { Disclosure } from './glance/Disclosure'
import { GlanceBackups, useBackupsGlance } from './glance/GlanceBackups'
import { GlanceMachines, useMachinesGlance } from './glance/GlanceMachines'
import { GlanceProjects, useProjectsGlance } from './glance/GlanceProjects'
import { GlanceQuota, useQuotaGlance } from './glance/GlanceQuota'
import { GlanceRecent, useRecentGlance } from './glance/GlanceRecent'
import { GlanceStatus, useStatusGlance } from './glance/GlanceStatus'
import styles from './Panel.module.css'

interface Place {
  label: string
  href: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
}

const PLACES: readonly Place[] = [
  { label: 'Grants', href: '/grants', icon: KeyRound },
  { label: 'Recovery', href: '/recovery', icon: Undo2 },
  { label: 'Logins', href: '/logins', icon: UserRound },
  { label: 'Context', href: '/agents', icon: BookOpen },
  { label: 'Phone app', href: '/app', icon: Smartphone },
]

function SectionHead({ title }: { title: string }) {
  return (
    <div className="lantern-sec">
      <h2>{title}</h2>
    </div>
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

export { QuotaBar } from './glance/GlanceQuota'

/** Every other place, one quiet list; a value only where it is read live. */
function Everything({ frame }: { frame: Frame | null }) {
  const { approvals } = useApprovals()
  const waiting = approvals?.state === 'ok' ? approvals.taps.length : undefined
  const glance: Record<string, { text: string; warn?: boolean } | undefined> = {
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
                frame.open(place.href, 'full')
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

/** Folds are kept per device, by section; a section nobody folded or opened follows its default. */
const FOLDS_KEY = 'aico-panel-folds'

/** Status, Quota, Backups, Recent, Machines and Projects: what to glance at, folded or open. */
function Glances() {
  const [stored, setStored] = useLocalStorageState<Record<string, boolean>>(
    FOLDS_KEY,
    {},
  )
  const folds = stored && typeof stored === 'object' ? stored : {}
  const phone = useMediaQuery('(max-width: 1023px)')
  const status = useStatusGlance()
  const quota = useQuotaGlance()
  const backups = useBackupsGlance()
  const recent = useRecentGlance()
  const machines = useMachinesGlance()
  const projects = useProjectsGlance()
  const sections: {
    id: string
    href: string
    where: 'wide' | 'full'
    head: { count: string | null; line: string | null }
    open: boolean
    body: ReactNode
  }[] = [
    {
      id: 'Status',
      href: '/status',
      where: 'wide',
      head: status,
      // On a phone Status stays open only when something is wrong (or not known yet).
      open: !phone || status.problems !== 0,
      body: <GlanceStatus />,
    },
    {
      id: 'Quota',
      href: '/quota',
      where: 'wide',
      head: quota,
      open: !phone,
      body: <GlanceQuota />,
    },
    {
      id: 'Backups',
      href: '/backups',
      where: 'full',
      head: backups,
      open: !phone,
      body: <GlanceBackups />,
    },
    {
      id: 'Recent',
      href: '/history',
      where: 'wide',
      head: recent,
      open: !phone,
      body: <GlanceRecent />,
    },
    {
      id: 'Machines',
      href: '/machines',
      where: 'full',
      head: machines,
      open: false,
      body: <GlanceMachines />,
    },
    {
      id: 'Projects',
      href: '/projects',
      where: 'wide',
      head: projects,
      open: false,
      body: <GlanceProjects />,
    },
  ]
  return (
    <>
      {sections.map((section) => {
        const open = folds[section.id] ?? section.open
        return (
          <Disclosure
            key={section.id}
            title={section.id}
            head={section.head}
            href={section.href}
            where={section.where}
            open={open}
            onToggle={() =>
              setStored((current) => ({
                ...(current && typeof current === 'object' ? current : {}),
                [section.id]: !open,
              }))
            }
          >
            {section.body}
          </Disclosure>
        )
      })}
    </>
  )
}

/** The left side's Panel: the triage view. What waits on you, every session
 * by state (each state group carries its own count), the glance sections,
 * then the places for setup. */
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
      <Glances />
      <Everything frame={frame} />
    </div>
  )
}
