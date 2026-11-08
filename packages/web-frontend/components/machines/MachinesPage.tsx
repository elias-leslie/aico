'use client'

import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { ConfirmationDialog } from '@/components/ConfirmationDialog'
import styles from '@/components/pages/FullPage.module.css'
import { awayAll, useAwayStatus } from '@/lib/hooks/use-machine-guests'
import { useMachineList } from '@/lib/hooks/use-machine-list'
import {
  autostartHint,
  INTENT_TAG,
  INTENT_TIP,
  MACHINES_LEGEND,
  type Machine,
  machinesLine,
  UP_CHIP,
  UP_WORD,
} from '@/lib/machines'
import { at, plural } from '@/lib/status'
import mine from './MachinesPage.module.css'
import {
  AutostartSwitch,
  messageOf,
  PowerButtons,
  PowerConfirm,
  useMachineControls,
} from './machine-controls'
import { StandbyTag } from './StandbyTag'

/** Machines: every machine once, whether it is up, what it is for, and power where it applies. */
export function MachinesPage() {
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
    settle,
    now,
  } = useMachineList()
  const awaySetup = useAwayStatus()
  const [askAway, setAskAway] = useState(false)
  const [awayState, setAwayState] = useState<'idle' | 'starting' | 'started'>(
    'idle',
  )
  const [awayError, setAwayError] = useState<string | null>(null)

  async function leave() {
    setAwayState('starting')
    setAwayError(null)
    try {
      await awayAll()
      setAskAway(false)
      setAwayState('started')
      settle()
    } catch (failure) {
      setAwayState('idle')
      setAwayError(messageOf(failure, 'Couldn’t start the shutdown.'))
    }
  }

  let body: React.ReactNode
  if (loading) {
    body = (
      <div className={styles.list} aria-hidden="true">
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
      </div>
    )
  } else if (bothFailed) {
    body = null
  } else if (list.machines.length === 0) {
    body = (
      <p className={styles.empty}>
        No machines have reported yet. Each one appears here once it reports to
        Aico or Aico links to it.
      </p>
    )
  } else {
    body = (
      <ul className={styles.list} aria-label="Machines">
        {list.machines.map((machine) => (
          <MachineRow key={machine.key} machine={machine} onChanged={moved} />
        ))}
      </ul>
    )
  }

  return (
    <main className={styles.page} aria-label="Machines">
      <div className={styles.inner}>
        <div className={styles.head}>
          <h1>Machines</h1>
          <button
            type="button"
            className="lantern-btn small"
            disabled={
              loading ||
              bothFailed ||
              awayState !== 'idle' ||
              awaySetup?.enabled !== true
            }
            title={
              awaySetup?.enabled === false
                ? awaySetup.reason
                : 'Shut down the Workstation and the Proxmox host so you can leave. Start them again from the Kasa app.'
            }
            onClick={() => {
              setAwayError(null)
              setAskAway(true)
            }}
          >
            {awayState === 'idle' ? 'Shut down all' : 'Shutting down…'}
          </button>
          <button
            type="button"
            className="lantern-btn ghost small"
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
        <p className={styles.sum} role="status">
          {loading
            ? 'Loading machines…'
            : bothFailed
              ? 'Not loaded'
              : machinesLine(list)}
        </p>
        {awayState === 'started' && (
          <div className={styles.notice} role="status">
            <p>
              <b>Shutting down.</b> Aico stops in a minute or two. To start the
              machines again, switch their sockets on in the Kasa app.
            </p>
          </div>
        )}
        {!loading && !bothFailed && list.machines.length > 0 && (
          <ul className={mine.legend} aria-label="What the labels mean">
            {MACHINES_LEGEND.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {bothFailed && (
          <div className={`${styles.notice} ${styles.bad}`} role="alert">
            <p>
              <b>Couldn’t load machines.</b> The Aico server didn’t answer, so
              nothing here counts as up.
            </p>
            <button
              type="button"
              className="lantern-btn small"
              onClick={refresh}
            >
              Try again
            </button>
          </div>
        )}
        {!loading && !bothFailed && status.failed && (
          <div className={styles.notice} role="status">
            <p>
              Couldn’t read the other machines, so only the ones sessions run on
              are listed.
            </p>
            <button
              type="button"
              className="lantern-btn small"
              onClick={refresh}
            >
              Try again
            </button>
          </div>
        )}
        {!loading && !bothFailed && !status.failed && status.stale && (
          <div className={styles.notice} role="status">
            <p>
              Couldn’t refresh. Showing what was read {at(status.readAt, now)}.
            </p>
            <button
              type="button"
              className="lantern-btn small"
              onClick={refresh}
            >
              Try again
            </button>
          </div>
        )}
        {!loading && !bothFailed && hosts.isError && list.hostsUnknown && (
          <div className={styles.notice} role="status">
            <p>
              Couldn’t check which machines can run sessions. Only the
              workstation is marked.
            </p>
            <button
              type="button"
              className="lantern-btn small"
              onClick={refresh}
            >
              Try again
            </button>
          </div>
        )}
        {!loading && !bothFailed && proxmox.failure && (
          <div className={styles.notice} role="status">
            <p>
              Couldn’t read Proxmox, so autostart isn’t shown and only the
              machines that run sessions can be powered. {proxmox.failure}
            </p>
            <button
              type="button"
              className="lantern-btn small"
              onClick={refresh}
            >
              Try again
            </button>
          </div>
        )}
        {body}
      </div>
      <ConfirmationDialog
        isOpen={askAway}
        title="Shut down all machines?"
        message="The Workstation and the Proxmox host shut down cleanly, then their plugs cut the power. Sessions running on them end and Aico goes offline. Status won’t flag them while they are off. To start them again, switch their sockets on in the Kasa app."
        confirmText="Shut down all"
        pendingText="Shutting down…"
        variant="danger"
        isPending={awayState === 'starting'}
        error={awayError}
        onConfirm={() => void leave()}
        onCancel={() => {
          setAskAway(false)
          setAwayError(null)
        }}
      />
    </main>
  )
}

function MachineRow({
  machine,
  onChanged,
}: {
  machine: Machine
  onChanged: () => void
}) {
  const controls = useMachineControls(machine, onChanged)
  const guest = machine.guest
  const name = machine.name
  const sessionsText =
    machine.sessions === null
      ? ''
      : machine.sessions === 0
        ? 'No sessions running'
        : `${plural(machine.sessions, 'session')} running`
  const hint = guest ? autostartHint(guest) : ''

  return (
    <li className={styles.row} data-testid={`machine-${machine.key}`}>
      <div className={styles.chipCol}>
        <span className={`status-chip ${UP_CHIP[machine.up]}`}>
          {UP_WORD[machine.up]}
        </span>
      </div>
      <div className={styles.main}>
        <div className={styles.title}>
          {name}
          {machine.sessionHost && (
            <span
              className={styles.tag}
              title="Sessions can be started and run on this machine"
            >
              Runs sessions
            </span>
          )}
          {guest?.intent && (
            <span className={mine.plainTag} title={INTENT_TIP[guest.intent]}>
              {INTENT_TAG[guest.intent]}
            </span>
          )}
          {machine.standby && (
            <StandbyTag standby={machine.standby} className={mine.plainTag} />
          )}
        </div>
        {machine.purpose && <p className={styles.line}>{machine.purpose}</p>}
        {machine.facts && <p className={styles.line}>{machine.facts}</p>}
        {(machine.note || sessionsText) && (
          <p className={styles.line}>
            {[sessionsText, machine.note].filter(Boolean).join(' · ')}
          </p>
        )}
        <AutostartSwitch
          controls={controls}
          hint={hint}
          lineClass={styles.line}
        />
      </div>
      <div className={styles.actions}>
        <PowerButtons controls={controls} />
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
