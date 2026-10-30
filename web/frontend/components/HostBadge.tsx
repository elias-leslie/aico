'use client'

/** The remote host a session runs on, beside its title: a neutral chip that
 * stays readable on a phone (it keeps its width up to 12 characters and the
 * title gives way; a longer name truncates, whole in the tooltip). While
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
      className="inline-block flex-none truncate rounded-full px-[6px] text-[11px] leading-4 whitespace-nowrap"
      style={{
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
