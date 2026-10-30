'use client'

import { Server } from 'lucide-react'
import { useState } from 'react'
import { useHosts } from '@/lib/hooks/use-hosts'
import { HostsSheet } from './HostsSheet'

/** The Hosts entry: shown only when Tether links to at least one other host.
 * `icon` is a square icon button (header, rail); otherwise a labelled row. */
export function HostsButton({
  onClick,
  icon = false,
}: {
  onClick: () => void
  icon?: boolean
}) {
  const { hosts } = useHosts()
  if (hosts.length === 0) return null
  return icon ? (
    <button
      type="button"
      className="lantern-icon-btn compact"
      onClick={onClick}
      aria-label="Hosts"
      title="Hosts"
      data-testid="hosts-btn"
    >
      <Server className="h-[18px] w-[18px]" strokeWidth={1.7} />
    </button>
  ) : (
    <button
      type="button"
      className="lantern-btn ghost small"
      onClick={onClick}
      data-testid="hosts-btn"
    >
      <Server className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      Hosts
    </button>
  )
}

/** The Hosts entry with its sheet, for places that stay mounted. */
export function HostsLauncher({ icon = false }: { icon?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <HostsButton icon={icon} onClick={() => setOpen(true)} />
      {open && <HostsSheet open onOpenChange={setOpen} />}
    </>
  )
}
