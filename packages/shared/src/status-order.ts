// What a Status problem costs if it is left alone, so the screen, the badge and `aico status`
// list lost work and security first, service trouble next and resource pressure last. One table:
// the first rule a row matches gives its tier; a row no rule names is service trouble.

export const TIERS = [
  { id: 'lost', label: 'Lost work' },
  { id: 'security', label: 'Security' },
  { id: 'service', label: 'Service' },
  { id: 'resource', label: 'Speed and space' },
] as const

export type Tier = (typeof TIERS)[number]['id']

interface Rule {
  tier: Tier
  /** Row kinds the rule covers. */
  kinds?: readonly string[]
  /** A pattern for the row id. Either field matching is enough. */
  id?: RegExp
}

const RULES: readonly Rule[] = [
  // Unsaved, unbacked-up or damaged work, and sessions or jobs killed for memory.
  {
    tier: 'lost',
    kinds: ['backup', 'repo'],
    id: /(^|\/)check-(backups|memory|disk-tests)$|^jobs\/backups-|(^|\/)job-scrub-/,
  },
  // Sudo, login, tripwire, grant and detection problems.
  {
    tier: 'security',
    kinds: ['grant'],
    id: /(^|\/)check-(sudo|security|tripwire|ominull-lock|router-drift)$|^ominull\.(detection|anomalies|compliance)\b/,
  },
  // Slow, full, hot or used up: nothing is lost yet.
  {
    tier: 'resource',
    id: /(^|\/)check-(perf|storage|thermal|trends|usage)$|^usage\/|(^|\/)job-(space-guard|housekeeping)$/,
  },
]

/** The tier of a Status row: lost work, security, service (the default) or resource pressure. */
export function tierOf(row: { id: string; kind: string }): Tier {
  const rule = RULES.find(
    (candidate) => candidate.kinds?.includes(row.kind) || candidate.id?.test(row.id),
  )
  return rule?.tier ?? 'service'
}

const ORDER = TIERS.map((tier) => tier.id)

/** Comparison for tiers: negative when `a` costs more than `b`. */
export function byTier(a: { id: string; kind: string }, b: { id: string; kind: string }): number {
  return ORDER.indexOf(tierOf(a)) - ORDER.indexOf(tierOf(b))
}

export function tierLabel(tier: Tier): string {
  return TIERS.find((candidate) => candidate.id === tier)?.label ?? tier
}
