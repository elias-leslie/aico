'use client'

import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import {
  AutostartSwitch,
  PowerButtons,
  PowerConfirm,
  useMachineControls,
} from '@/components/machines/machine-controls'
import { useClock } from '@/lib/hooks/use-clock'
import { useHosts } from '@/lib/hooks/use-hosts'
import { useMachineList } from '@/lib/hooks/use-machine-list'
import { useStatus } from '@/lib/hooks/use-status'
import {
  autostartHint,
  buildMachines,
  INTENT_TAG,
  type Machine,
  type Machines,
  UP_CHIP,
  UP_WORD,
} from '@/lib/machines'
import { at, plural } from '@/lib/status'
import styles from './GlanceMachines.module.css'
import type { GlanceHead } from './glance-types'

/** Every machine once, from Status and the session hosts; null while neither has answered. The heading's
 * count needs no Proxmox read, so it does not ask for one. */
function useCountedMachines(): { list: Machines | null; loading: boolean } {
  const status = useStatus()
  const hosts = useHosts()
  const now = useClock(60_000)
  const hostsKnown = !hosts.isError || hosts.hosts.length > 0
  const loading = (status.loading && !status.view) || hosts.isLoading
  const list = loading
    ? null
    : buildMachines(status.view, hostsKnown ? hosts.hosts : null, now)
  return { list, loading }
}

/** Machines for the heading: "5 of 8 up", amber when one is starting or not answering; why, when it is not known. */
export function useMachinesGlance(): GlanceHead {
  const { list, loading } = useCountedMachines()
  if (loading) return { value: 'Checking…', tone: null }
  if (!list || list.partial) return { value: 'Couldn’t read', tone: 'unknown' }
  const total = list.machines.length
  const up = list.machines.filter((machine) => machine.up === 'on').length
  const off = list.machines.filter((machine) => machine.up === 'off').length
  return {
    value: `${up} of ${total} up`,
    tone: up + off < total ? 'warn' : null,
  }
}

function Row({
  machine,
  onChanged,
}: {
  machine: Machine
  onChanged: () => void
}) {
  const controls = useMachineControls(machine, onChanged)
  const [open, setOpen] = useState(false)
  const guest = machine.guest
  const tag = guest?.intent ? INTENT_TAG[guest.intent] : null
  const hint = guest ? autostartHint(guest) : ''
  const more = [machine.facts, hint].filter(Boolean)
  const sessionsText =
    machine.sessions === null
      ? ''
      : machine.sessions === 0
        ? 'No sessions running'
        : `${plural(machine.sessions, 'session')} running`
  const line = [sessionsText, machine.note].filter(Boolean).join(' · ')
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className={styles.row} data-testid={`glance-machine-${machine.key}`}>
      <div className={styles.head}>
        <span className={`status-chip ${UP_CHIP[machine.up]}`}>
          {UP_WORD[machine.up]}
        </span>
        {more.length > 0 ? (
          <button
            type="button"
            className={styles.name}
            aria-expanded={open}
            onClick={() => setOpen((now) => !now)}
          >
            {machine.name}
            <Chevron
              className="h-3.5 w-3.5"
              strokeWidth={1.7}
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className={styles.name}>{machine.name}</span>
        )}
        {machine.sessionHost && (
          <span
            className={styles.tag}
            title="Sessions can be started and run on this machine"
          >
            Runs sessions
          </span>
        )}
        {tag && (
          <span
            className={styles.tag}
            title="Where the project registry says this machine should be"
          >
            {tag}
          </span>
        )}
      </div>
      {machine.purpose && <p className={styles.line}>{machine.purpose}</p>}
      {line && <p className={styles.line}>{line}</p>}
      {open &&
        more.map((text) => (
          <p key={text} className={styles.line}>
            {text}
          </p>
        ))}
      <div className={styles.controls}>
        <PowerButtons controls={controls} />
        <AutostartSwitch controls={controls} hint="" lineClass={styles.line} />
      </div>
      {controls.error && (
        <p role="alert" className={styles.err}>
          {controls.error}
        </p>
      )}
      <PowerConfirm controls={controls} />
    </li>
  )
}

/** Notes are the page's own words, short, with a way to try again. */
function Note({
  children,
  retry,
  role = 'status',
  bad = false,
}: {
  children: string
  retry?: () => void
  role?: 'status' | 'alert'
  bad?: boolean
}) {
  return (
    <div
      className={styles.note}
      data-bad={bad ? 'true' : undefined}
      role={role}
    >
      <p>{children}</p>
      {retry && (
        <button type="button" className="lantern-btn small" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  )
}

/** Each machine with its state chip and the controls the Machines page has: power on, restart, shut down,
 * autostart and trust. Shut down and restart ask first. "Shut down all" and the legend stay on the page. */
export function GlanceMachines() {
  const {
    status,
    hosts,
    proxmox,
    list,
    loading,
    bothFailed,
    refresh,
    refreshing,
    moved,
    now,
  } = useMachineList()
  if (loading)
    return (
      <p className={styles.plain} role="status">
        Checking machines…
      </p>
    )
  if (bothFailed)
    return (
      <Note bad role="alert" retry={refresh}>
        Couldn’t load machines. The Aico server didn’t answer, so nothing here
        counts as up.
      </Note>
    )
  const sorted = [...list.machines].sort(
    (a, b) => Number(b.up === 'on') - Number(a.up === 'on'),
  )
  return (
    <div className={styles.wrap}>
      {status.failed && (
        <Note retry={refresh}>
          Couldn’t read the other machines, so only the ones sessions run on are
          listed.
        </Note>
      )}
      {!status.failed && status.stale && (
        <Note retry={refresh}>
          {`Couldn’t refresh. Showing what was read ${at(status.readAt, now)}.`}
        </Note>
      )}
      {hosts.isError && list.hostsUnknown && (
        <Note retry={refresh}>
          Couldn’t check which machines can run sessions. Only the workstation
          is marked.
        </Note>
      )}
      {proxmox.failure && (
        <Note retry={refresh}>
          {`Couldn’t read Proxmox, so autostart isn’t shown and only the machines that run sessions can be powered. ${proxmox.failure}`}
        </Note>
      )}
      {sorted.length === 0 ? (
        <p className={styles.plain}>
          No machines have reported yet. Each one appears here once it reports
          to Aico or Aico links to it.
        </p>
      ) : (
        <ul className={styles.list} aria-label="Machines">
          {sorted.map((machine) => (
            <Row key={machine.key} machine={machine} onChanged={moved} />
          ))}
        </ul>
      )}
      <button
        type="button"
        className={`lantern-btn ghost small ${styles.refresh}`}
        disabled={refreshing}
        onClick={refresh}
      >
        <RefreshCw
          className="h-3.5 w-3.5"
          strokeWidth={1.7}
          aria-hidden="true"
        />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  )
}
