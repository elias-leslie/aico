'use client'

import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { ConfirmationDialog } from '@/components/ConfirmationDialog'
import styles from '@/components/pages/FullPage.module.css'
import { useClock } from '@/lib/hooks/use-clock'
import { HostCallError, powerHost, trustHost } from '@/lib/hooks/use-host-admin'
import { useHosts } from '@/lib/hooks/use-hosts'
import { useStatus } from '@/lib/hooks/use-status'
import {
  buildMachines,
  type Machine,
  machinesLine,
  UP_CHIP,
  UP_WORD,
} from '@/lib/machines'
import { at, plural } from '@/lib/status'

const messageOf = (failure: unknown, fallback: string) =>
  failure instanceof Error && failure.message ? failure.message : fallback

type Confirm = { kind: 'off' | 'trust'; message: string; confirmText: string }

/** Machines: every machine once, whether it is up, what it is for, and power where it applies. */
export function MachinesPage() {
  const status = useStatus()
  const hosts = useHosts()
  const now = useClock()
  const queryClient = useQueryClient()

  // The hosts are read when this opens; a failed read with nothing earlier is unknown, not none.
  const hostsKnown = !hosts.isError || hosts.hosts.length > 0
  const loading = (status.loading && !status.view) || hosts.isLoading
  const bothFailed = status.failed && hosts.isError && hosts.hosts.length === 0
  const list = buildMachines(status.view, hostsKnown ? hosts.hosts : null, now)
  const refreshing = status.refreshing
  const refresh = () => {
    void status.refetch()
    void hosts.refetch()
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
          <MachineRow
            key={machine.key}
            machine={machine}
            onChanged={() =>
              void queryClient.invalidateQueries({ queryKey: ['hosts'] })
            }
          />
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
        {body}
      </div>
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
  const [busy, setBusy] = useState<'on' | 'off' | 'trust' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const host = machine.host
  const name = machine.name

  async function run(
    action: 'on' | 'off' | 'trust',
    force: boolean,
    inDialog: boolean,
  ) {
    if (!host) return
    setBusy(action)
    setError(null)
    setConfirmError(null)
    try {
      if (action === 'trust') await trustHost(host)
      else await powerHost(host, action, force)
      setConfirm(null)
      onChanged()
    } catch (failure) {
      const fallback =
        action === 'trust'
          ? `Couldn’t trust ${name}.`
          : `Couldn’t power ${action} ${name}.`
      if (inDialog) setConfirmError(messageOf(failure, fallback))
      else if (
        action === 'off' &&
        failure instanceof HostCallError &&
        failure.status === 409
      )
        // The machine says sessions are running there: offer to do it anyway.
        setConfirm({
          kind: 'off',
          message: failure.message,
          confirmText: 'Power off anyway',
        })
      else setError(messageOf(failure, fallback))
    } finally {
      setBusy(null)
    }
  }

  const askOff = () => {
    setConfirmError(null)
    setConfirm({
      kind: 'off',
      message:
        machine.sessions && machine.sessions > 0
          ? `${plural(machine.sessions, 'session')} running on ${name} will end. It stays off until someone starts it.`
          : `${name} stays off until someone starts it.`,
      confirmText: 'Power off',
    })
  }

  const sessionsText =
    machine.sessions === null
      ? ''
      : machine.sessions === 0
        ? 'No sessions running'
        : `${plural(machine.sessions, 'session')} running`

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
        </div>
        {machine.purpose && <p className={styles.line}>{machine.purpose}</p>}
        {(machine.note || sessionsText) && (
          <p className={styles.line}>
            {[sessionsText, machine.note].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {machine.power === 'on' && (
          <button
            type="button"
            className="lantern-btn small primary"
            disabled={busy !== null}
            onClick={() => void run('on', false, false)}
          >
            {busy === 'on' ? 'Powering on…' : 'Power on'}
          </button>
        )}
        {machine.power === 'off' && (
          <button
            type="button"
            className="lantern-btn small"
            disabled={busy !== null}
            onClick={askOff}
          >
            {busy === 'off' ? 'Powering off…' : 'Power off'}
          </button>
        )}
        {machine.power === 'trust' && (
          <button
            type="button"
            className="lantern-btn small primary"
            disabled={busy !== null}
            onClick={() => {
              setConfirmError(null)
              setConfirm({
                kind: 'trust',
                message: `Trust the machine now answering as ${name}?`,
                confirmText: 'Trust',
              })
            }}
          >
            Trust
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className={styles.err}>
          {error}
        </p>
      )}
      <ConfirmationDialog
        isOpen={confirm !== null}
        title={
          confirm?.kind === 'trust'
            ? 'Trust this machine?'
            : `Power off ${name}?`
        }
        message={confirm?.message ?? ''}
        confirmText={confirm?.confirmText ?? 'Power off'}
        pendingText={confirm?.kind === 'trust' ? 'Trusting…' : 'Powering off…'}
        variant={confirm?.kind === 'trust' ? 'warning' : 'danger'}
        isPending={busy === 'off' || busy === 'trust'}
        error={confirmError}
        onConfirm={() =>
          void run(confirm?.kind === 'trust' ? 'trust' : 'off', true, true)
        }
        onCancel={() => {
          setConfirm(null)
          setConfirmError(null)
        }}
      />
    </li>
  )
}
