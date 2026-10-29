// The effort choices Agent Hub's catalog allows a model, for the composer's
// Effort select. Nothing here knows a model by name: a model takes a level when
// the catalog says it reasons (`has_thinking`), `xhigh` only when it says so
// (`supports_xhigh`), and not a level its `thinking_level_map` sets to null.
// A level the map leaves out takes the default mapping, so it is allowed.

/** The ladder in order. `ultrathink` is what Agent Hub's turn API calls `xhigh`. */
const LADDER = [
  { value: 'minimal', level: 'minimal', label: 'Minimal' },
  { value: 'low', level: 'low', label: 'Low' },
  { value: 'medium', level: 'medium', label: 'Medium' },
  { value: 'high', level: 'high', label: 'High' },
  { value: 'ultrathink', level: 'xhigh', label: 'Extra high' },
] as const

export interface EffortChoice {
  /** What the turn request carries (`thinking_level`). */
  value: string
  label: string
}

/** The part of a catalog model this needs (the SDK's `ModelInfo`). */
export interface EffortModel {
  id: string
  capabilities?: {
    has_thinking?: boolean
    supports_xhigh?: boolean
    thinking_level_map?: Record<string, unknown> | null
  } | null
}

/** The choices for a model; none when it has no reasoning effort to set. */
export function effortChoices(model: EffortModel | undefined | null): EffortChoice[] {
  const caps = model?.capabilities
  if (!caps?.has_thinking) return []
  const map = caps.thinking_level_map ?? {}
  return LADDER.filter(
    (entry) =>
      (entry.level !== 'xhigh' || caps.supports_xhigh === true) && map[entry.level] !== null,
  ).map(({ value, label }) => ({ value, label }))
}

/** The effort to keep when the model changes: the same level if the new model takes it, else none. */
export function effortFor(choices: readonly EffortChoice[], current: string): string {
  return choices.some((choice) => choice.value === current) ? current : ''
}
