'use client'

import { useState } from 'react'
import { ConfirmationDialog } from '@/components/ConfirmationDialog'
import {
  type MachineService,
  restartService,
  useMachineServices,
} from '@/lib/hooks/use-machine-guests'
import type { Machine } from '@/lib/machines'
import mine from './MachinesPage.module.css'
import { messageOf } from './machine-controls'

const CHIP: Record<string, { chip: string; word: string }> = {
  active: { chip: 'ok', word: 'On' },
  reloading: { chip: 'warn', word: 'Restarting' },
  activating: { chip: 'warn', word: 'Starting' },
  deactivating: { chip: 'warn', word: 'Stopping' },
  inactive: { chip: 'off', word: 'Off' },
  failed: { chip: 'failed', word: 'Failed' },
}
const chipOf = (state: string) =>
  CHIP[state] ?? { chip: 'unknown', word: 'Unknown' }

/** Aico's services on a machine that runs Aico, each with its restart; nothing on any other machine. */
export function ServiceList({ machine }: { machine: Machine }) {
  const { machines, refetch } = useMachineServices()
  const [asking, setAsking] = useState<MachineService | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const group = machines?.find((entry) => entry.machine === machine.key)
  if (!group) return null
  if (!group.units)
    return machine.up === 'on' ? (
      <span
        className="status-chip unknown"
        title={group.error ?? 'It didn’t answer.'}
      >
        Services unknown
      </span>
    ) : null
  const units = group.units
  const down = units.filter((unit) => unit.state !== 'active').length

  async function restart() {
    if (!asking) return
    setPending(true)
    setError(null)
    try {
      await restartService(machine.key, asking.unit)
      setAsking(null)
      void refetch()
    } catch (failure) {
      setError(messageOf(failure, `${asking.label} didn’t restart.`))
    } finally {
      setPending(false)
    }
  }

  return (
    <details className={mine.services}>
      <summary title="Aico’s services on this machine">
        Services
        <span
          className={`status-chip ${down ? 'failed' : 'ok'}`}
          title={
            down
              ? `${down} of ${units.length} not running`
              : `All ${units.length} running`
          }
        >
          {down ? down : units.length}
        </span>
      </summary>
      <ul className={mine.serviceList}>
        {units.map((unit) => {
          const shown = chipOf(unit.state)
          return (
            <li key={unit.unit}>
              <span className={`status-chip ${shown.chip}`}>{shown.word}</span>
              <span className={mine.serviceName} title={unit.unit}>
                {unit.label}
              </span>
              <button
                type="button"
                className="lantern-btn small"
                onClick={() => {
                  setError(null)
                  setAsking(unit)
                }}
              >
                Restart
              </button>
            </li>
          )
        })}
      </ul>
      <ConfirmationDialog
        isOpen={asking !== null}
        title={`Restart ${asking?.label ?? ''} on ${machine.name}?`}
        message={
          asking?.reloadsPage && machine.here
            ? 'This page drops for a few seconds, then reconnects. Running sessions carry on.'
            : 'Running sessions carry on.'
        }
        confirmText="Restart"
        pendingText="Restarting…"
        variant="warning"
        isPending={pending}
        error={error}
        onConfirm={() => void restart()}
        onCancel={() => {
          setAsking(null)
          setError(null)
        }}
      />
    </details>
  )
}
