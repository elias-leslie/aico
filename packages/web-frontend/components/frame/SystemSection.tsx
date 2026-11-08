'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
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
  worst: 'ok' | 'warn' | 'failed' | 'pending'
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
  const worst = chips.some((chip) => chip.tone === 'failed')
    ? 'failed'
    : chips.length
      ? 'warn'
      : pending
        ? 'pending'
        : 'ok'
  return {
    chips,
    pending,
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

/** The System row's value: a chip for each problem, else "All OK" and how many machines are up. */
function Verdict({ state }: { state: SystemState }) {
  if (state.chips.length > 0)
    return (
      <span className="ml-auto flex min-w-0 flex-wrap justify-end gap-1">
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

/** System: one line when all is well ("All OK · 4 of 8 machines up"), its problems as chips on that line
 * when not. It opens by itself while something needs attention, and on a click; its rows are Status,
 * Backups and Machines. A rail pop-out shows the rows. */
export function SystemSection({ popout = false }: { popout?: boolean }) {
  const state = useSystemState()
  // Until the owner clicks it follows what is there: shut when all is well, open when not.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? state.worst !== 'ok'
  if (popout)
    return (
      <GlancePopover
        title="System"
        head={{
          value:
            state.chips.length > 0
              ? `${state.chips.length} to look at`
              : state.pending
                ? PENDING
                : 'All OK',
          tone:
            state.worst === 'failed'
              ? 'failed'
              : state.worst === 'warn'
                ? 'warn'
                : state.worst === 'ok'
                  ? 'ok'
                  : null,
        }}
      >
        <SystemRows />
      </GlancePopover>
    )
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
          className={styles.row}
          aria-expanded={open}
          onClick={() => setChosen(!open)}
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
