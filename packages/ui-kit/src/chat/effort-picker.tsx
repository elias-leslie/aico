// The effort for the next message in an Agent Hub chat, a select in the
// composer's bar beside the model. The choices come from the catalog for the
// chosen model (effort.ts); a model with none shows no select at all. Empty is
// the model's own default.

import type { EffortChoice } from './effort'

interface EffortPickerProps {
  choices: readonly EffortChoice[]
  /** The chosen level; empty for the model's own default. */
  value: string
  onChange(level: string): void
}

export function EffortPicker({ choices, value, onChange }: EffortPickerProps) {
  if (!choices.length) return null
  return (
    <label className="chat-model-pick chat-effort-pick">
      <span>Effort</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Default</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  )
}
