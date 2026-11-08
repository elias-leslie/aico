'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import { RoutinesBody, useRoutinesHead } from '../routines/Routines'
import { Disclosure } from './glance/Disclosure'
import styles from './glance/Glance.module.css'
import { GlanceBackups, useBackupsGlance } from './glance/GlanceBackups'
import { GlanceMachines, useMachinesGlance } from './glance/GlanceMachines'
import { GlancePopover } from './glance/GlancePopover'
import { GlanceStatus, useStatusGlance } from './glance/GlanceStatus'
import type { GlanceHead, GlanceTone } from './glance/glance-types'
import { usePanelFold } from './panel-folds'

const PENDING = 'Checking…'
const UNREADABLE = 'Couldn’t read'

type SystemRowId = 'Status' | 'Backups' | 'Machines' | 'Routines'

export interface SystemChip {
  text: string
  tone: GlanceTone
}

export interface SystemState {
  /** What needs attention, each as the chip the collapsed line wears. */
  chips: SystemChip[]
  /** Something is still being read, so "all OK" is not yet known. */
  pending: boolean
  /** "4 of 8 machines up": the one fact the line keeps when all is well. */
  machines: string | null
  /** Notes (warnings alone) are a muted chip and count as neither warn nor failed. */
  worst: 'ok' | 'warn' | 'failed' | 'pending'
  /** Some section could not be read: what needs the owner is not known, not gone. */
  unread: boolean
  /** What needs the owner to act, by section; the section opens by itself only for these. */
  needs: Record<string, number>
  heads: Record<SystemRowId, GlanceHead>
}

/** Status, Backups and Machines as one verdict: a problem in any of them is a chip on the collapsed line. */
export function useSystemState(): SystemState {
  const status = useStatusGlance()
  const backups = useBackupsGlance()
  const machines = useMachinesGlance()
  const routines = useRoutinesHead()
  const chips: SystemChip[] = []
  const pending = [status, backups, machines, routines].some(
    (head) => head.value === PENDING,
  )
  if (status.value !== PENDING) {
    if (status.problems === null)
      chips.push({ text: 'Status unreadable', tone: 'failed' })
    else if (status.problems > 0)
      chips.push({ text: status.value ?? '', tone: status.tone ?? 'warn' })
  }
  if (backups.value !== PENDING && backups.tone && backups.tone !== 'ok')
    chips.push({
      text:
        backups.value === UNREADABLE
          ? 'Backups unreadable'
          : `Backups ${backups.value}`,
      tone: backups.tone,
    })
  if (machines.value !== PENDING && machines.tone)
    chips.push({
      text:
        machines.value === UNREADABLE
          ? 'Machines unreadable'
          : machinesWords(machines.value),
      tone: machines.tone,
    })
  if (routines.value !== PENDING && routines.tone && routines.tone !== 'ok')
    chips.push({
      text:
        routines.value === UNREADABLE
          ? 'Routines unreadable'
          : `Routines ${(routines.value ?? '').split(' · ').slice(1).join(' · ')}`,
      tone: routines.tone,
    })
  const up =
    machines.value &&
    machines.value !== UNREADABLE &&
    machines.value !== PENDING
  const loud = chips.filter((chip) => chip.tone !== 'off')
  const worst = loud.some((chip) => chip.tone === 'failed')
    ? 'failed'
    : loud.length
      ? 'warn'
      : pending
        ? 'pending'
        : 'ok'
  const needs: Record<string, number> = {}
  const heads = { Status: status, Backups: backups, Machines: machines }
  for (const [id, head] of Object.entries(heads))
    if (head.value !== PENDING && head.value !== UNREADABLE && head.needs)
      needs[id] = head.needs
  return {
    chips,
    pending,
    unread: chips.some((chip) => /unreadable$/.test(chip.text)),
    needs,
    machines: up ? machinesWords(machines.value) : null,
    worst,
    heads: {
      Status: status,
      Backups: backups,
      Machines: machines,
      Routines: routines,
    },
  }
}

/** "4 of 8 up" reads "4 of 8 machines up" beside the other words. */
function machinesWords(value: string | null): string {
  return (value ?? '').replace(/^(\d+ of \d+) up$/, '$1 machines up')
}

/** The System row's value: a chip for each problem (one beside the label, several under it), else
 * "All OK" and how many machines are up. */
function Verdict({ state }: { state: SystemState }) {
  if (state.chips.length > 0)
    return (
      <span
        className={
          state.chips.length > 1
            ? styles.chipsBelow
            : 'ml-auto flex min-w-0 justify-end'
        }
      >
        {state.chips.map((chip) => (
          <span
            key={chip.text}
            className={`status-chip ${chip.tone} ${styles.chip}`}
            style={{ marginLeft: 0 }}
          >
            {chip.text}
          </span>
        ))}
      </span>
    )
  if (state.pending) return <span className={styles.value}>{PENDING}</span>
  return (
    <span className="ml-auto flex min-w-0 items-center justify-end gap-2">
      <span
        className={`status-chip ok ${styles.chip}`}
        style={{ marginLeft: 0 }}
      >
        All OK
      </span>
      {state.machines && <span className={styles.value}>{state.machines}</span>}
    </span>
  )
}

/** The rows inside System. */
function SystemRows() {
  const state = useSystemState()
  const row = (id: SystemRowId, body: ReactNode) => (
    <SystemRow key={id} id={id} head={state.heads[id]}>
      {body}
    </SystemRow>
  )
  return (
    <div>
      {row('Status', <GlanceStatus />)}
      {row('Backups', <GlanceBackups />)}
      {row('Machines', <GlanceMachines />)}
      {row('Routines', <RoutinesBody />)}
    </div>
  )
}

function SystemRow({
  id,
  head,
  children,
}: {
  id: string
  head: GlanceHead
  children: ReactNode
}) {
  const [open, setOpen] = usePanelFold(`system:${id}`, false)
  return (
    <Disclosure
      title={id}
      head={head}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      {children}
    </Disclosure>
  )
}

/** Where the owner shut System while things needed them, by section and how many; it opens by itself
 * again only when one of those grows, and the memory is dropped once nothing needs them. */
const SEEN_KEY = 'aico-system-seen-needs'

/** System: one line when all is well ("All OK · 4 of 8 machines up"), its problems and notes as chips on
 * that line when not. It opens by itself only for what needs the owner (a failed or late row to act on,
 * a backup out of date, a machine that should be up and is down), never for warnings, and not again
 * after the owner shut it until something more needs them. It opens on a click; its rows are Status,
 * Backups, Machines and Routines. A rail pop-out shows the rows. */
export function SystemSection({ popout = false }: { popout?: boolean }) {
  const state = useSystemState()
  const [seen, setSeen] = useLocalStorageState<Record<string, number>>(
    SEEN_KEY,
    {},
  )
  // A click on a shut section holds it open until the owner shuts it again.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const wanting = Object.keys(state.needs).length > 0
  const known = seen && typeof seen === 'object' ? seen : {}
  const grew = Object.entries(state.needs).some(
    ([id, n]) => n > (known[id] ?? 0),
  )
  const open = chosen ?? grew
  // Once nothing needs the owner, the next need is a new one.
  useEffect(() => {
    if (
      !wanting &&
      !state.pending &&
      !state.unread &&
      Object.keys(known).length > 0
    )
      setSeen({})
  }, [wanting, state.pending, state.unread, known, setSeen])
  const toggle = () => {
    if (open) {
      setChosen(null)
      setSeen({ ...state.needs })
    } else setChosen(true)
  }
  if (popout) {
    const loud = state.chips.filter((chip) => chip.tone !== 'off')
    return (
      <GlancePopover
        title="System"
        head={{
          value:
            loud.length > 0
              ? `${loud.length} to look at`
              : state.chips.length > 0
                ? state.chips[0].text
                : state.pending
                  ? PENDING
                  : 'All OK',
          tone:
            state.worst === 'failed'
              ? 'failed'
              : state.worst === 'warn'
                ? 'warn'
                : state.chips.length > 0
                  ? 'off'
                  : state.worst === 'ok'
                    ? 'ok'
                    : null,
        }}
      >
        <SystemRows />
      </GlancePopover>
    )
  }
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section
      className={styles.disclosure}
      aria-label="System"
      data-testid="system-section"
      data-worst={state.worst}
    >
      <h2 className={styles.rowHead}>
        <button
          type="button"
          className={
            state.chips.length > 1
              ? `${styles.row} ${styles.rowStacked}`
              : styles.row
          }
          aria-expanded={open}
          onClick={toggle}
        >
          <Chevron
            className={styles.chevron}
            strokeWidth={1.7}
            aria-hidden="true"
          />
          <span className={styles.label}>System</span>
          <Verdict state={state} />
        </button>
      </h2>
      {open && <SystemRows />}
    </section>
  )
}
