/** How much of an entry home's `.codex/sessions` one state read looks at
 * (continuity.ts `entryCodexRollout`). One agent runs per home, so a few
 * rollouts is the norm; these bound a home that holds very many. */
export interface EntryScanConfig {
  /** Rollout files listed per read (TETHER_ENTRY_ROLLOUT_SCAN). */
  rolloutScan: number
  /** Of those, the newest opened to find the user thread (TETHER_ENTRY_ROLLOUT_OPEN). */
  rolloutOpen: number
}

export const ENTRY_SCAN_DEFAULTS: EntryScanConfig = { rolloutScan: 2000, rolloutOpen: 32 }

export function resolveEntryScanConfig(env: NodeJS.ProcessEnv = process.env): EntryScanConfig {
  const read = (name: string, fallback: number) => {
    const raw = env[name]
    if (raw === undefined) return fallback
    if (!/^\d+$/.test(raw) || Number(raw) < 1)
      throw new Error(`${name} must be a whole number, at least 1`)
    return Number(raw)
  }
  return {
    rolloutScan: read('TETHER_ENTRY_ROLLOUT_SCAN', ENTRY_SCAN_DEFAULTS.rolloutScan),
    rolloutOpen: read('TETHER_ENTRY_ROLLOUT_OPEN', ENTRY_SCAN_DEFAULTS.rolloutOpen),
  }
}
