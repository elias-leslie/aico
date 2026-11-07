'use client'

import { type ReactNode, useState } from 'react'
import { ConfirmationDialog } from '@/components/ConfirmationDialog'
import { HostCallError, powerHost, trustHost } from '@/lib/hooks/use-host-admin'
import { powerMachine, setAutostart } from '@/lib/hooks/use-machine-guests'
import type { Machine } from '@/lib/machines'
import { plural } from '@/lib/status'
import mine from './MachinesPage.module.css'

export const messageOf = (failure: unknown, fallback: string) =>
  failure instanceof Error && failure.message ? failure.message : fallback

type Action = 'on' | 'off' | 'restart' | 'trust'
type Busy = Action | 'autostart' | null

interface Confirm {
  kind: 'off' | 'restart' | 'trust'
  message: string
  confirmText: string
}

const ACTION_LABEL = { off: 'Shut down', restart: 'Restart' } as const
const ACTION_WORD = {
  on: 'power on',
  off: 'shut down',
  restart: 'restart',
} as const

/**
 * Everything a machine's power, restart, trust and autostart controls do, once: the Machines page and
 * the Panel's glance both use it, so they ask the same questions and call the same routes.
 */
export function useMachineControls(machine: Machine, onChanged: () => void) {
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const host = machine.host
  const guest = machine.guest
  const name = machine.name

  async function run(action: Action, force: boolean, inDialog: boolean) {
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
  const askTrust = () => {
    setConfirmError(null)
    setConfirm({
      kind: 'trust',
      message: `Trust the machine now answering as ${name}?`,
      confirmText: 'Trust',
    })
  }

  // With Proxmox read, the guest says what can be done; otherwise only a session host can be
  // powered, through its link.
  const working =
    busy !== null ||
    guest?.busy != null ||
    machine.up === 'starting' ||
    machine.up === 'stopping' ||
    machine.up === 'restarting'
  const canStart =
    !!guest?.powerable &&
    (guest.state === 'stopped' || guest.state === 'down') &&
    machine.up === 'off' &&
    !working
  const canStop =
    !!guest?.powerable &&
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
  return {
    machine,
    busy,
    error,
    confirm,
    confirmError,
    canStart,
    canStop,
    working,
    progress,
    run,
    ask,
    askTrust,
    toggleAutostart,
    cancelConfirm: () => {
      setConfirm(null)
      setConfirmError(null)
    },
  }
}

export type MachineControls = ReturnType<typeof useMachineControls>

/** The buttons a machine offers right now (none when nothing can be done from here). */
export function PowerButtons({
  controls,
  small = true,
}: {
  controls: MachineControls
  small?: boolean
}) {
  const { machine, busy, canStart, canStop, working, progress, run, ask } =
    controls
  const guest = machine.guest
  const size = small ? 'lantern-btn small' : 'lantern-btn'
  return (
    <>
      {guest ? (
        <>
          {canStart && (
            <button
              type="button"
              className={`${size} primary`}
              onClick={() => void run('on', false, false)}
            >
              Power on
            </button>
          )}
          {canStop && (
            <>
              <button
                type="button"
                className={size}
                onClick={() => ask('restart')}
              >
                Restart
              </button>
              <button type="button" className={size} onClick={() => ask('off')}>
                Shut down
              </button>
            </>
          )}
          {working && progress && (
            <button type="button" className={size} disabled>
              {progress}
            </button>
          )}
        </>
      ) : (
        <>
          {machine.power === 'on' && (
            <button
              type="button"
              className={`${size} primary`}
              disabled={busy !== null}
              onClick={() => void run('on', false, false)}
            >
              {busy === 'on' ? 'Starting…' : 'Power on'}
            </button>
          )}
          {machine.power === 'off' && (
            <button
              type="button"
              className={size}
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
          className={`${size} primary`}
          disabled={busy !== null}
          onClick={controls.askTrust}
        >
          Trust
        </button>
      )}
    </>
  )
}

/** The autostart switch with its hint, or the plain line when Proxmox didn't say; nothing without a guest. */
export function AutostartSwitch({
  controls,
  hint,
  lineClass,
}: {
  controls: MachineControls
  hint: string
  lineClass: string
}): ReactNode {
  const guest = controls.machine.guest
  if (!guest) return null
  return (
    <div className={mine.autostart}>
      {guest.autostart === null ? (
        <p className={lineClass}>Autostart: Proxmox didn’t say.</p>
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
              disabled={controls.busy !== null}
              onChange={(event) =>
                void controls.toggleAutostart(event.target.checked)
              }
            />
            <span className={mine.track} aria-hidden="true" />
            <span>
              {controls.busy === 'autostart'
                ? 'Saving autostart…'
                : 'Autostart'}
            </span>
          </label>
          {hint && <p className={lineClass}>{hint}</p>}
        </>
      )}
    </div>
  )
}

/** Confirms the destructive moves (shut down, restart) and trusting a changed machine. */
export function PowerConfirm({ controls }: { controls: MachineControls }) {
  const { confirm, machine, busy, confirmError, run, cancelConfirm } = controls
  return (
    <ConfirmationDialog
      isOpen={confirm !== null}
      title={
        confirm?.kind === 'trust'
          ? 'Trust this machine?'
          : confirm?.kind === 'restart'
            ? `Restart ${machine.name}?`
            : `Shut down ${machine.name}?`
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
      onCancel={cancelConfirm}
    />
  )
}
