'use client'

/** The remote host a session runs on, beside its title: a neutral chip that
 * stays readable on a phone. It shows up to 12 characters and gives up width
 * only once the title is down to its minimum (the title side shrinks 100 times
 * faster; a flex-shrink below 1 would hand the chip only that fraction of what
 * is left to free, and the bar would overlap), so the two never overlap; the
 * whole name is in the tooltip. While
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
      className="inline-block truncate rounded-full px-[6px] text-[11px] leading-4 whitespace-nowrap"
      style={{
        flex: '0 1 auto',
        minWidth: '3ch',
        maxWidth: 'calc(12ch + 14px)',
        border: '1px solid rgb(var(--glass-rgb) / 0.14)',
        color: 'var(--mist)',
        opacity: away ? 0.6 : 1,
      }}
    >
      {host}
    </span>
  )
}
