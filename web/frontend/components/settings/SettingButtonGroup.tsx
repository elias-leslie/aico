'use client'

export interface SettingButtonGroupProps<T extends string> {
  label: string
  value: T
  options: readonly T[]
  onChange: (value: T) => void
  capitalize?: boolean
}

export function SettingButtonGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  capitalize = true,
}: SettingButtonGroupProps<T>) {
  return (
    <div className="mb-4">
      <label
        className="block text-xs font-medium mb-1.5"
        style={{ color: 'var(--term-text-muted)' }}
      >
        {label}
      </label>
      <div className="flex gap-1.5">
        {options.map((option) => {
          const isActive = value === option
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              className={`flex-1 px-2 py-2.5 min-h-[44px] text-xs rounded-md transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--term-accent)] ${capitalize ? 'capitalize' : ''}`}
              style={{
                backgroundColor: isActive
                  ? 'var(--term-accent)'
                  : 'var(--term-bg-deep)',
                color: isActive
                  ? 'var(--term-accent-foreground)'
                  : 'var(--term-text-muted)',
                border: `1px solid ${isActive ? 'var(--term-accent)' : 'var(--term-border)'}`,
                boxShadow: isActive
                  ? '0 0 8px var(--term-accent-glow)'
                  : 'none',
              }}
            >
              {option}
            </button>
          )
        })}
      </div>
    </div>
  )
}
