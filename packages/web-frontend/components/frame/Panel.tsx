import { useQueryClient } from '@tanstack/react-query'
import { Settings, StickyNote } from 'lucide-react'
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { useHosts } from '@/lib/hooks/use-hosts'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { useStatus } from '@/lib/hooks/use-status'
import {
  RECOVERY_QUERY_KEY,
  useStatusSessions,
} from '@/lib/hooks/use-status-sessions'
import { popOutNotes } from '@/lib/notes-window'
import { rowButtons, type StatusRow } from '@/lib/status'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { NeedsYouSection } from '../asks/NeedsYou'
import { CaptureLauncher } from '../capture/CaptureLauncher'
import { SessionList } from '../SessionList'
import { useFrame } from './FrameContext'
import { Disclosure } from './glance/Disclosure'
import { GlanceBackups, useBackupsGlance } from './glance/GlanceBackups'
import { GlanceMachines, useMachinesGlance } from './glance/GlanceMachines'
import { GlanceProjects, useProjectsGlance } from './glance/GlanceProjects'
import { GlanceQuota, useQuotaGlance } from './glance/GlanceQuota'
import { GlanceRecent, useRecentGlance } from './glance/GlanceRecent'
import { GlanceStatus, useStatusGlance } from './glance/GlanceStatus'
import styles from './Panel.module.css'
import { SettingsMenu, SettingsPage } from './Settings'

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

/** Folds are kept per device, by section; a section nobody folded or opened follows its default. */
const FOLDS_KEY = 'aico-panel-folds'

/** Status, Quota, Backups, Recent, Machines and Projects: what to glance at, folded or open. */
function Glances() {
  const [stored, setStored] = useLocalStorageState<Record<string, boolean>>(
    FOLDS_KEY,
    {},
  )
  const folds = stored && typeof stored === 'object' ? stored : {}
  // A phone is where the side slides over the session; a snapped desktop window keeps the desktop defaults.
  const frame = useFrame()
  const phone = frame !== null && !frame.docked
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

/** Notes opens in its own window, as from Full's side list. */
function NotesButton() {
  return (
    <button
      type="button"
      className="lantern-btn ghost small"
      title="Notes open in their own window"
      onClick={() => {
        if (!popOutNotes('/notes')) window.location.assign('/notes')
      }}
    >
      <StickyNote className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      Notes
    </button>
  )
}

/** The left side's Panel: the triage view. What waits on you, every session
 * by state (each state group carries its own count), the glance sections,
 * and a footer pinned to the bottom: Notes, Capture and Settings. On a
 * phone Settings is a page inside the sheet, with Back. */
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
  const sheet = frame !== null && !frame.docked
  const [settings, setSettings] = useState(false)
  if (sheet && settings)
    return (
      <div className={styles.panel} data-testid="session-sidebar">
        <SettingsPage frame={frame} onBack={() => setSettings(false)} />
      </div>
    )
  return (
    <div className={styles.panel} data-testid="session-sidebar">
      <div className={styles.scroll}>
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
      </div>
      <div className={styles.foot}>
        <NotesButton />
        <CaptureLauncher variant="row" />
        {sheet ? (
          <button
            type="button"
            className={`lantern-btn ghost small ${styles.settingsWrap}`}
            onClick={() => setSettings(true)}
          >
            <Settings
              className="h-4 w-4"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            Settings
          </button>
        ) : (
          <SettingsMenu frame={frame} />
        )}
      </div>
    </div>
  )
}
