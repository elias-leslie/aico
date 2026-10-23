'use client'

export interface SettingSelectProps {
  label: string
  value: string | number
  onChange: (value: string | number) => void
  options: Array<{ value: string | number; label: string }>
}

export function SettingSelect({
  label,
  value,
  onChange,
  options,
}: SettingSelectProps) {
  return (
    <div className="mb-4">
      <label
        className="block text-xs font-medium mb-1.5"
        style={{ color: 'var(--term-text-muted)' }}
      >
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => {
          const val = e.target.value
          // Try to parse as number if original value was number
          onChange(typeof value === 'number' ? Number(val) : val)
        }}
        className="term-input w-full px-2.5 py-3 min-h-[44px] text-sm rounded-md focus:outline-none"
        style={{
          backgroundColor: 'var(--term-bg-deep)',
          border: '1px solid var(--term-border)',
          color: 'var(--term-text-primary)',
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}
