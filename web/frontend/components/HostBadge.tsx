'use client'

/** The remote host a session runs on, beside its title: a neutral chip that
 * stays readable on a phone (it gives up width before the title does). While
 * the host cannot be reached its state shows in the tooltip and the chip dims. */
export function HostBadge({
  host,
  state,
}: {
  host: string | null | undefined
  state?: string | null
}) {
  if (!host) return null
  const away = !!state && state !== 'connected'
  const label = away
    ? `Runs on ${host} (${state.replace('_', ' ')})`
    : `Runs on ${host}`
  return (
    <span
      data-testid="host-badge"
      title={label}
      aria-label={label}
      className="inline-block shrink truncate rounded-full px-[6px] text-[11px] leading-4 whitespace-nowrap"
      style={{
        minWidth: '3ch',
        maxWidth: '14ch',
        border: '1px solid rgb(var(--glass-rgb) / 0.14)',
        color: 'var(--mist)',
        opacity: away ? 0.6 : 1,
      }}
    >
      {host}
    </span>
  )
}
