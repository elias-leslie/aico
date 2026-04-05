'use client'

/**
 * Skeleton loading state for A-Term.
 * Shows a pulsing placeholder while A-Term panes are loading.
 */
export function ATermSkeleton() {
  return (
    <div
      className="flex-1 flex flex-col"
      style={{ backgroundColor: 'var(--term-bg-deep)' }}
      aria-busy="true"
      aria-label="Loading A-Term"
    >
      {/* Header skeleton */}
      <div
        className="flex items-center gap-2 px-3 h-8"
        style={{
          backgroundColor: 'var(--term-bg-surface)',
          borderBottom: '1px solid var(--term-border)',
        }}
      >
        <div
          className="h-4 w-6 rounded animate-pulse"
          style={{ backgroundColor: 'var(--term-bg-elevated)' }}
        />
        <div
          className="h-3.5 w-20 rounded animate-pulse"
          style={{ backgroundColor: 'var(--term-bg-elevated)', animationDelay: '50ms' }}
        />
        <div
          className="h-3 w-12 rounded-full animate-pulse"
          style={{ backgroundColor: 'var(--term-bg-elevated)', animationDelay: '100ms' }}
        />
        <div className="flex-1" />
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <div
              key={`header-dot-${i}`}
              className="h-3.5 w-3.5 rounded animate-pulse"
              style={{ backgroundColor: 'var(--term-bg-elevated)', animationDelay: `${150 + i * 50}ms` }}
            />
          ))}
        </div>
      </div>

      {/* A-Term content skeleton */}
      <div className="flex-1 p-4 space-y-2.5 overflow-hidden">
        {/* Fake prompt line */}
        <div className="flex items-center gap-2">
          <div
            className="h-3.5 w-16 rounded animate-pulse"
            style={{ backgroundColor: 'var(--term-accent-glow)' }}
          />
          <div
            className="h-3.5 w-28 rounded animate-pulse"
            style={{ backgroundColor: 'var(--term-bg-elevated)', animationDelay: '100ms' }}
          />
        </div>

        {/* Fake output lines with staggered delays */}
        {[0.7, 0.55, 0.85, 0.4, 0.65, 0.5, 0.75, 0.35].map((width, i) => (
          <div
            key={`skeleton-${width}`}
            className="h-3 rounded animate-pulse"
            style={{
              backgroundColor: 'var(--term-bg-elevated)',
              width: `${width * 100}%`,
              opacity: 0.4 + i * 0.04,
              animationDelay: `${200 + i * 80}ms`,
            }}
          />
        ))}

        {/* Blinking cursor line */}
        <div className="flex items-center gap-2 mt-6">
          <div
            className="h-3.5 w-16 rounded animate-pulse"
            style={{ backgroundColor: 'var(--term-accent-glow)' }}
          />
          <div
            className="h-4 w-2 rounded-sm animate-pulse"
            style={{
              backgroundColor: 'var(--term-accent)',
              animationDuration: '0.8s',
            }}
          />
        </div>
      </div>
    </div>
  )
}
