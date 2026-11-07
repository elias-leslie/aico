'use client'

import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ConfirmationDialog } from '@/components/ConfirmationDialog'
import styles from '@/components/pages/FullPage.module.css'
import { useClock } from '@/lib/hooks/use-clock'
import { HostCallError, powerHost, trustHost } from '@/lib/hooks/use-host-admin'
import { isStarting, useHosts } from '@/lib/hooks/use-hosts'
import {
  awayAll,
  powerMachine,
  setAutostart,
  useAwayStatus,
  useMachineGuests,
} from '@/lib/hooks/use-machine-guests'
import { useStatus } from '@/lib/hooks/use-status'
import {
  autostartHint,
  buildMachines,
  INTENT_TAG,
  MACHINES_LEGEND,
  type Machine,
  machinesLine,
  UP_CHIP,
  UP_WORD,
} from '@/lib/machines'
import { at, plural } from '@/lib/status'
import mine from './MachinesPage.module.css'

const messageOf = (failure: unknown, fallback: string) =>
  failure instanceof Error && failure.message ? failure.message : fallback

/** How long Proxmox is read every 2 s after a power move (a clean shutdown takes about this long). */
const SETTLE_MS = 60_000

type Confirm = {
  kind: 'off' | 'restart' | 'trust'
  message: string
  confirmText: string
}

/** Machines: every machine once, whether it is up, what it is for, and power where it applies. */
export function MachinesPage() {
  const status = useStatus()
  const hosts = useHosts()
  // After a power move, Proxmox is read often until the machine has settled.
  const [settling, setSettling] = useState(false)
  useEffect(() => {
    if (!settling) return
    const timer = setTimeout(() => setSettling(false), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [settling])
  const moving = hosts.hosts.some(
    (host) =>
      isStarting(host) ||
      host.state === 'connecting' ||
      host.state === 'offline',
  )
  const proxmox = useMachineGuests(settling || moving)
  const refetchHosts = hosts.refetch
  useEffect(() => {
    // A link coming up or a machine in the middle of a power move: keep the page current.
    if (!settling && !moving) return
    const timer = setInterval(() => void refetchHosts(), 3_000)
    return () => clearInterval(timer)
  }, [settling, moving, refetchHosts])
  const now = useClock()
  const queryClient = useQueryClient()
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
      setSettling(true)
    } catch (failure) {
      setAwayState('idle')
      setAwayError(messageOf(failure, 'Couldn’t start the shutdown.'))
    }
  }

  // The hosts are read when this opens; a failed read with nothing earlier is unknown, not none.
  const hostsKnown = !hosts.isError || hosts.hosts.length > 0
  const loading =
    (status.loading && !status.view) || hosts.isLoading || proxmox.isLoading
  const bothFailed = status.failed && hosts.isError && hosts.hosts.length === 0
  const list = buildMachines(
    status.view,
    hostsKnown ? hosts.hosts : null,
    now,
    proxmox.guests,
  )
  const refreshing = status.refreshing
  const refresh = () => {
    void status.refetch()
    void hosts.refetch()
    void proxmox.refetch()
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
            onChanged={() => {
              setSettling(true)
              void queryClient.invalidateQueries({ queryKey: ['hosts'] })
              void queryClient.invalidateQueries({
                queryKey: ['machine-guests'],
              })
            }}
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
  const [busy, setBusy] = useState<
    'on' | 'off' | 'restart' | 'trust' | 'autostart' | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const host = machine.host
  const guest = machine.guest
  const name = machine.name

  async function run(
    action: 'on' | 'off' | 'restart' | 'trust',
    force: boolean,
    inDialog: boolean,
  ) {
    if (!host && !guest) return
    setBusy(action)
    setError(null)
    setConfirmError(null)
    try {
      if (action === 'trust' && host) await trustHost(host)
      else if (guest && action !== 'trust')
        await powerMachine(machine.key, action, force)
      else if (host && (action === 'on' || action === 'off'))
        await powerHost(host, action, force)
      setConfirm(null)
      onChanged()
    } catch (failure) {
      const fallback =
        action === 'trust'
          ? `Couldn’t trust ${name}.`
          : `Couldn’t ${ACTION_WORD[action]} ${name}.`
      if (inDialog) setConfirmError(messageOf(failure, fallback))
      else if (
        (action === 'off' || action === 'restart') &&
        failure instanceof HostCallError &&
        failure.status === 409
      )
        // The machine says sessions are running there: offer to do it anyway.
        setConfirm({
          kind: action,
          message: failure.message,
          confirmText: `${ACTION_LABEL[action]} anyway`,
        })
      else setError(messageOf(failure, fallback))
    } finally {
      setBusy(null)
    }
  }

  async function toggleAutostart(on: boolean) {
    setBusy('autostart')
    setError(null)
    try {
      await setAutostart(machine.key, on)
      onChanged()
    } catch (failure) {
      setError(
        messageOf(failure, `Couldn’t turn autostart ${on ? 'on' : 'off'}.`),
      )
    } finally {
      setBusy(null)
    }
  }

  const sessionsNow = machine.sessions && machine.sessions > 0
  const keepsOn = guest?.intent === 'always'
  const ask = (kind: 'off' | 'restart') => {
    setConfirmError(null)
    const sessions = sessionsNow
      ? `${plural(machine.sessions ?? 0, 'session')} running on ${name} will end.`
      : ''
    setConfirm({
      kind,
      message:
        kind === 'restart'
          ? `${sessions || `${name} restarts.`} It is back in a minute or two.`
          : [
              sessions,
              `${name} stays off until someone starts it.`,
              keepsOn ? 'Status won’t flag it while you have it off.' : '',
            ]
              .filter(Boolean)
              .join(' '),
      confirmText: ACTION_LABEL[kind],
    })
  }

  const sessionsText =
    machine.sessions === null
      ? ''
      : machine.sessions === 0
        ? 'No sessions running'
        : `${plural(machine.sessions, 'session')} running`

  // With Proxmox read, the guest says what can be done; otherwise only a session host can be
  // powered, through its link.
  const working =
    busy !== null ||
    guest?.busy != null ||
    machine.up === 'starting' ||
    machine.up === 'stopping' ||
    machine.up === 'restarting'
  const canStart =
    guest?.powerable &&
    (guest.state === 'stopped' || guest.state === 'down') &&
    machine.up === 'off' &&
    !working
  const canStop =
    guest?.powerable &&
    guest.state === 'running' &&
    machine.up !== 'off' &&
    !working
  const progress =
    busy === 'on' || machine.up === 'starting'
      ? 'Starting…'
      : busy === 'off' || machine.up === 'stopping'
        ? 'Shutting down…'
        : busy === 'restart' || machine.up === 'restarting'
          ? 'Restarting…'
          : null
  const tag = guest?.intent ? INTENT_TAG[guest.intent] : null
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
          {tag && (
            <span
              className={mine.plainTag}
              title="Where the project registry says this machine should be: Always on, On demand or Parked"
            >
              {tag}
            </span>
          )}
        </div>
        {machine.purpose && <p className={styles.line}>{machine.purpose}</p>}
        {machine.facts && <p className={styles.line}>{machine.facts}</p>}
        {(machine.note || sessionsText) && (
          <p className={styles.line}>
            {[sessionsText, machine.note].filter(Boolean).join(' · ')}
          </p>
        )}
        {guest && (
          <div className={mine.autostart}>
            {guest.autostart === null ? (
              <p className={styles.line}>Autostart: Proxmox didn’t say.</p>
            ) : (
              <>
                <label
                  className={mine.switch}
                  title="Autostart: starts when the Proxmox host boots"
                >
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={guest.autostart}
                    checked={guest.autostart}
                    disabled={busy !== null}
                    onChange={(event) =>
                      void toggleAutostart(event.target.checked)
                    }
                  />
                  <span className={mine.track} aria-hidden="true" />
                  <span>
                    {busy === 'autostart' ? 'Saving autostart…' : 'Autostart'}
                  </span>
                </label>
                {hint && <p className={styles.line}>{hint}</p>}
              </>
            )}
          </div>
        )}
      </div>
      <div className={styles.actions}>
        {guest ? (
          <>
            {canStart && (
              <button
                type="button"
                className="lantern-btn small primary"
                onClick={() => void run('on', false, false)}
              >
                Power on
              </button>
            )}
            {canStop && (
              <>
                <button
                  type="button"
                  className="lantern-btn small"
                  onClick={() => ask('restart')}
                >
                  Restart
                </button>
                <button
                  type="button"
                  className="lantern-btn small"
                  onClick={() => ask('off')}
                >
                  Shut down
                </button>
              </>
            )}
            {working && progress && (
              <button type="button" className="lantern-btn small" disabled>
                {progress}
              </button>
            )}
          </>
        ) : (
          <>
            {machine.power === 'on' && (
              <button
                type="button"
                className="lantern-btn small primary"
                disabled={busy !== null}
                onClick={() => void run('on', false, false)}
              >
                {busy === 'on' ? 'Starting…' : 'Power on'}
              </button>
            )}
            {machine.power === 'off' && (
              <button
                type="button"
                className="lantern-btn small"
                disabled={busy !== null}
                onClick={() => ask('off')}
              >
                {busy === 'off' ? 'Shutting down…' : 'Shut down'}
              </button>
            )}
          </>
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
            : confirm?.kind === 'restart'
              ? `Restart ${name}?`
              : `Shut down ${name}?`
        }
        message={confirm?.message ?? ''}
        confirmText={confirm?.confirmText ?? 'Shut down'}
        pendingText={
          confirm?.kind === 'trust'
            ? 'Trusting…'
            : confirm?.kind === 'restart'
              ? 'Restarting…'
              : 'Shutting down…'
        }
        variant={confirm?.kind === 'trust' ? 'warning' : 'danger'}
        isPending={busy === 'off' || busy === 'restart' || busy === 'trust'}
        error={confirmError}
        onConfirm={() => void run(confirm?.kind ?? 'off', true, true)}
        onCancel={() => {
          setConfirm(null)
          setConfirmError(null)
        }}
      />
    </li>
  )
}

const ACTION_LABEL = { off: 'Shut down', restart: 'Restart' } as const
const ACTION_WORD = {
  on: 'power on',
  off: 'shut down',
  restart: 'restart',
} as const
