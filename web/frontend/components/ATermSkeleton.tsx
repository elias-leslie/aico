'use client'

const LINES = [0.7, 0.55, 0.85, 0.4, 0.65, 0.5, 0.75, 0.35]

/** Placeholder while the session list loads: the bar and an empty terminal,
 * with the session list beside them on wide screens. */
export function ATermSkeleton() {
  const block = 'rounded motion-safe:animate-pulse'
  const paper = { backgroundColor: 'var(--paper-veil)' }
  return (
    <div
      className="flex flex-1"
      style={{ backgroundColor: 'var(--rim)' }}
      aria-busy="true"
      aria-label="Loading Aico"
    >
      <div
        className="hidden w-[320px] flex-none flex-col lg:flex"
        style={{ borderRight: '1px solid rgb(var(--glass-rgb) / 0.05)' }}
      >
        <div className="flex h-12 items-center gap-2 px-3">
          <div className={`${block} h-6 w-6`} style={paper} />
          <div className={`${block} h-4 w-12`} style={paper} />
          <div className="flex-1" />
          <div className={`${block} h-8 w-32`} style={paper} />
        </div>
        <div className="space-y-4 px-4 pt-4">
          {LINES.slice(0, 5).map((width, i) => (
            <div key={width} className="flex items-center gap-3">
              <div className={`${block} h-4 w-4`} style={paper} />
              <div
                className={`${block} h-3.5`}
                style={{
                  ...paper,
                  width: `${width * 70}%`,
                  animationDelay: `${i * 80}ms`,
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
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
    </div>
  )
}
