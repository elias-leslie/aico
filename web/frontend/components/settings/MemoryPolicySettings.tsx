'use client'

import { useState } from 'react'
import {
  type KillOrder,
  type MemoryPolicy,
  useMemoryPolicy,
} from '@/lib/hooks/use-memory-policy'
import { SettingButtonGroup } from './SettingButtonGroup'
import { SettingCheckbox } from './SettingCheckbox'
import { SettingSelect } from './SettingSelect'

const KILL_ORDERS = ['largest', 'background-first'] as const

/** Preset choices, plus the stored value when it is not one of them. */
function choices(
  presets: number[],
  current: number,
  label: (n: number) => string,
) {
  const values = presets.includes(current)
    ? presets
    : [...presets, current].sort((a, b) => a - b)
  return values.map((n) => ({ value: n, label: label(n) }))
}

const gib = (n: number) => `${n} GiB`
const seconds = (n: number) => `${n} s`

function Note({ children, alert }: { children: string; alert?: boolean }) {
  return (
    <div
      className="mb-2 rounded px-2 py-1.5 text-[10px]"
      role={alert ? 'alert' : undefined}
      style={
        alert
          ? {
              backgroundColor: 'var(--term-error-muted)',
              color: 'var(--term-error-text)',
            }
          : { color: 'var(--term-text-muted)' }
      }
    >
      {children}
    </div>
  )
}

/** Agent pane memory: the pane cap and which runaway job Tether kills
 * when the workstation runs out of memory. */
export function MemoryPolicySettings() {
  const { state, isLoading, loadError, save } = useMemoryPolicy()
  const [saveError, setSaveError] = useState<string | null>(null)

  const change = async (patch: Partial<MemoryPolicy>) => {
    try {
      await save(patch)
      setSaveError(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save')
    }
  }

  const policy = state?.policy
  return (
    <div
      className="mt-4 pt-4"
      style={{ borderTop: '1px solid var(--term-border)' }}
      data-testid="memory-policy-settings"
    >
      <div
        className="mb-2 text-[10px] font-medium tracking-wider"
        style={{
          color: 'var(--term-text-muted)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        AGENT MEMORY
      </div>

      {isLoading && <Note>Loading…</Note>}
      {loadError && <Note alert>{loadError}</Note>}
      {saveError && <Note alert>{saveError}</Note>}

      {policy && (
        <>
          <SettingSelect
            label="Memory cap per pane"
            value={policy.paneMemoryMaxGib}
            onChange={(v) => change({ paneMemoryMaxGib: Number(v) })}
            options={choices(
              [8, 10, 12, 16, 20, 24, 32],
              policy.paneMemoryMaxGib,
              gib,
            )}
          />
          <SettingSelect
            label="Swap cap per pane"
            value={policy.paneSwapMaxGib}
            onChange={(v) => change({ paneSwapMaxGib: Number(v) })}
            options={choices([0, 1, 2, 4, 8], policy.paneSwapMaxGib, (n) =>
              n === 0 ? 'No swap' : gib(n),
            )}
          />
          <SettingCheckbox
            label="Kill a runaway job when memory runs out"
            checked={policy.killEnabled}
            onChange={(on) => change({ killEnabled: on })}
          />
          {policy.killEnabled && (
            <>
              <SettingButtonGroup<KillOrder>
                label="Kill first"
                value={policy.killOrder}
                options={KILL_ORDERS}
                titles={{
                  largest: 'The biggest agent job in any pane',
                  'background-first':
                    'Spare the pane you are looking at while another pane has a big job',
                }}
                onChange={(order) => change({ killOrder: order })}
              />
              <SettingSelect
                label="Smallest job to kill"
                value={policy.killMinGib}
                onChange={(v) => change({ killMinGib: Number(v) })}
                options={choices([0.5, 1, 2, 4], policy.killMinGib, gib)}
              />
              <SettingSelect
                label="Wait while memory is critical"
                value={policy.killAfterSeconds}
                onChange={(v) => change({ killAfterSeconds: Number(v) })}
                options={choices(
                  [5, 10, 20, 30, 60],
                  policy.killAfterSeconds,
                  seconds,
                )}
              />
              <SettingSelect
                label="Time between kills"
                value={policy.killGapSeconds}
                onChange={(v) => change({ killGapSeconds: Number(v) })}
                options={choices(
                  [15, 30, 60, 120],
                  policy.killGapSeconds,
                  seconds,
                )}
              />
            </>
          )}
          <Note>Agents and pane shells are never killed.</Note>
          {state?.guard && !state.guard.running && (
            <Note>Kills only run on the main Tether, not this one.</Note>
          )}
        </>
      )}
    </div>
  )
}
