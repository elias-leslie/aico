'use client'

export interface SettingCheckboxProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}

export function SettingCheckbox({
  label,
  checked,
  onChange,
}: SettingCheckboxProps) {
  return (
    <div className="mb-4">
      <label className="flex items-center gap-3 cursor-pointer min-h-[44px] px-2 -mx-2 rounded-md hover:bg-[var(--term-bg-deep)] transition-colors">
        <span
          className="relative flex items-center justify-center w-5 h-5 rounded border transition-all duration-150"
          style={{
            backgroundColor: checked ? 'var(--term-accent)' : 'var(--term-bg-deep)',
            borderColor: checked ? 'var(--term-accent)' : 'var(--term-border)',
            boxShadow: checked ? '0 0 6px var(--term-accent-glow)' : 'none',
          }}
        >
          {checked && (
            <svg
              className="w-3 h-3"
              style={{ color: 'var(--term-accent-foreground)' }}
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2.5 6L5 8.5L9.5 3.5" />
            </svg>
          )}
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="absolute inset-0 opacity-0 cursor-pointer"
            aria-label={label}
          />
        </span>
        <span
          className="text-sm"
          style={{ color: checked ? 'var(--term-text-primary)' : 'var(--term-text-muted)' }}
        >
          {label}
        </span>
      </label>
    </div>
  )
}
