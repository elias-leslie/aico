'use client'

const LINES = [0.7, 0.55, 0.85, 0.4, 0.65, 0.5, 0.75, 0.35]

/** Placeholder while the session list loads: the bar and an empty terminal. */
export function ATermSkeleton() {
  const block = 'rounded motion-safe:animate-pulse'
  const paper = { backgroundColor: 'var(--paper-veil)' }
  return (
    <div
      className="flex flex-1 flex-col"
      style={{ backgroundColor: 'var(--rim)' }}
      aria-busy="true"
      aria-label="Loading Aico"
    >
      <div className="flex h-12 items-center gap-2.5 px-3">
        <div className={`${block} h-5 w-5`} style={paper} />
        <div className={`${block} h-4 w-36`} style={paper} />
        <div className="flex-1" />
        {[0, 1, 2].map((i) => (
          <div key={i} className={`${block} h-5 w-5`} style={paper} />
        ))}
      </div>
      <div
        className="mx-1 mb-1 flex-1 space-y-2.5 overflow-hidden rounded p-4"
        style={{
          backgroundColor: 'var(--ink)',
          boxShadow: 'inset 0 0 0 1px var(--frame-edge)',
        }}
      >
        {LINES.map((width, i) => (
          <div
            key={width}
            className={`${block} h-3`}
            style={{
              backgroundColor: 'var(--paper)',
              width: `${width * 100}%`,
              animationDelay: `${i * 80}ms`,
            }}
          />
        ))}
      </div>
    </div>
  )
}
