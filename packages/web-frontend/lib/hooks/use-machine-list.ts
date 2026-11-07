'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { useClock } from '@/lib/hooks/use-clock'
import { isStarting, useHosts } from '@/lib/hooks/use-hosts'
import { useMachineGuests } from '@/lib/hooks/use-machine-guests'
import { useStatus } from '@/lib/hooks/use-status'
import { buildMachines } from '@/lib/machines'

/** How long Proxmox is read every 2 s after a power move (a clean shutdown takes about this long). */
const SETTLE_MS = 60_000

/**
 * Every machine once, with its Proxmox guest: what the Machines page and the Panel's glance both
 * list. `moved()` follows a power move (it reads Proxmox often until things settle).
 */
export function useMachineList() {
  const status = useStatus()
  const hosts = useHosts()
  const queryClient = useQueryClient()
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
    // A link coming up or a machine in the middle of a power move: keep the list current.
    if (!settling && !moving) return
    const timer = setInterval(() => void refetchHosts(), 3_000)
    return () => clearInterval(timer)
  }, [settling, moving, refetchHosts])
  const now = useClock()

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
  const refresh = () => {
    void status.refetch()
    void hosts.refetch()
    void proxmox.refetch()
  }
  const moved = useCallback(() => {
    setSettling(true)
    void queryClient.invalidateQueries({ queryKey: ['hosts'] })
    void queryClient.invalidateQueries({ queryKey: ['machine-guests'] })
  }, [queryClient])
  return {
    status,
    hosts,
    // Only whether Proxmox could be read: the rest of the query stays here.
    proxmox: { failure: proxmox.failure },
    list,
    loading,
    bothFailed,
    refresh,
    moved,
    settle: () => setSettling(true),
    now,
    refreshing: status.refreshing,
  }
}
