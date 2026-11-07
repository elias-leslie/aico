'use client'

import { useClock } from '@/lib/hooks/use-clock'
import { useHosts } from '@/lib/hooks/use-hosts'
import { useStatus } from '@/lib/hooks/use-status'
import {
  buildMachines,
  type Machines,
  machinesGlance,
  UP_CHIP,
  UP_WORD,
} from '@/lib/machines'
import styles from './Glance.module.css'
import type { GlanceHead } from './glance-types'

/** Every machine once, from Status and the session hosts; null while neither has answered. */
function useMachineList(): {
  list: Machines | null
  loading: boolean
  stale: boolean
} {
  const status = useStatus()
  const hosts = useHosts()
  const now = useClock(60_000)
  const hostsKnown = !hosts.isError || hosts.hosts.length > 0
  const loading = (status.loading && !status.view) || hosts.isLoading
  const list = loading
    ? null
    : buildMachines(status.view, hostsKnown ? hosts.hosts : null, now)
  return { list, loading, stale: status.stale }
}

/** Machines for the Panel's heading: "4 up, 4 off", or why that is not known. */
export function useMachinesGlance(): GlanceHead {
  const { list, loading } = useMachineList()
  const count = list ? machinesGlance(list) : null
  if (count) return { count, line: null }
  return {
    count: null,
    line: loading
      ? 'Checking machines…'
      : 'Machines couldn’t be read; only the session hosts are known.',
  }
}

/** Each machine's name with a chip for whether it is up. */
export function GlanceMachines() {
  const { list, loading, stale } = useMachineList()
  if (!list)
    return (
      <p className={styles.note} role={loading ? 'status' : 'alert'}>
        {loading ? 'Checking machines…' : 'Machines couldn’t be read.'}
      </p>
    )
  return (
    <div data-stale={stale ? 'true' : undefined}>
      {list.partial && (
        <p className={styles.note}>
          Status couldn’t be read, so only the session hosts are listed.
        </p>
      )}
      <ul className={styles.machines}>
        {[...list.machines]
          .sort((a, b) => Number(b.up === 'on') - Number(a.up === 'on'))
          .map((machine) => (
            <li
              key={machine.key}
              className={`status-chip ${UP_CHIP[machine.up]}`}
              title={`${machine.name}: ${UP_WORD[machine.up]}`}
            >
              {machine.name}
              <span className="sr-only">
                {' '}
                is {UP_WORD[machine.up].toLowerCase()}
              </span>
            </li>
          ))}
      </ul>
    </div>
  )
}
