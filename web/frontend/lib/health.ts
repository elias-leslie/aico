// The Health panel's words and tones, from Nightshift's owner view
// (web/server src/nightshift.ts passes Nightshift's GET /api/view through).
// Nightshift decides every state; this only says it. Unknown is never OK.

/** A board state, as Nightshift names it. */
export type CheckState = 'ok' | 'note' | 'warn' | 'crit' | 'unkn'

export interface HealthTile {
  id: string
  label: string
  state: CheckState
  summary: string
  /** Seconds since the shown result began, when known. */
  age: number | null
  link: string
}

export interface HealthFinding {
  id: string
  host: string
  host_label: string
  check: string
  state: CheckState
  summary: string
  /** 'You', 'Agent', 'Nightshift' or ''. */
  who: string
  owner: boolean
  /** What Nightshift or its agent does next ('' for the owner's own calls). */
  next: string
  age: number | null
  link: string
}

export interface HealthApproval {
  id: string
  title: string
  url: string
  /** Seconds left to approve. */
  left: number
}

export interface NightshiftOwnerView {
  version: 1
  snapshot: { state: 'fresh' | 'stale' | 'missing'; age: number | null }
  verdict: { state: string; label: string; reason: string; doing: string }
  tiles: HealthTile[]
  findings: HealthFinding[]
  needs_you: number
  approvals: HealthApproval[]
  links: { status: string; needs_you: string; notices: string }
}

export type NightshiftViewResult =
  | { available: true; view: NightshiftOwnerView }
  | {
      available: false
      reason: 'not_configured' | 'not_answering' | 'unexpected'
    }

export type Tone = 'good' | 'warn' | 'danger' | 'quiet'

export const TONE_COLOR: Record<Tone, string> = {
  good: 'var(--jade)',
  warn: 'var(--beacon)',
  danger: 'var(--ember)',
  quiet: 'var(--mist)',
}

export const STATE_TONE: Record<CheckState, Tone> = {
  ok: 'good',
  note: 'quiet',
  warn: 'warn',
  crit: 'danger',
  unkn: 'quiet',
}

export const STATE_WORD: Record<CheckState, string> = {
  ok: 'OK',
  note: 'Note',
  warn: 'Warning',
  crit: 'Critical',
  unkn: 'Unknown',
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** `45 s`, `3 min`, `2 h`, `4 days`. */
export function ageText(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'an unknown time'
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 2 * 86400) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86400)} days`
}

const UNAVAILABLE: Record<
  Extract<NightshiftViewResult, { available: false }>['reason'],
  string
> = {
  not_answering: 'Nightshift isn’t answering, so health is unknown.',
  not_configured: 'Health isn’t set up for this app, so it’s unknown.',
  unexpected:
    'Nightshift answered in a form this app can’t read, so health is unknown.',
}

/** Why health is unknown right now, or null when the view is current. */
export function unknownReason(
  result: NightshiftViewResult | undefined,
  loadFailed: boolean,
): string | null {
  if (!result) return loadFailed ? 'Couldn’t load health.' : null
  if (loadFailed)
    return 'Couldn’t refresh health, so what’s shown may be out of date.'
  if (!result.available) return UNAVAILABLE[result.reason]
  const { snapshot } = result.view
  if (snapshot.state === 'missing')
    return 'Nightshift hasn’t reported a check yet, so health is unknown.'
  if (snapshot.state === 'stale')
    return `Nightshift’s last check was ${ageText(snapshot.age)} ago, so health is unknown until it reports again.`
  return null
}

export interface PillState {
  tone: Tone
  /** Short: fits the session list header and the phone. */
  label: string
  /** Problems to count on the icon (critical and warnings). */
  count: number
  /** The full sentence, for the tooltip and screen readers. */
  title: string
}

/** The Health pill: Health OK, Health: 1 warning, Health unknown. */
export function pillState(
  result: NightshiftViewResult | undefined,
  loadFailed: boolean,
  loading: boolean,
): PillState {
  if (!result && loading && !loadFailed)
    return {
      tone: 'quiet',
      label: 'Health',
      count: 0,
      title: 'Health · loading',
    }
  const unknown = unknownReason(result, loadFailed)
  if (unknown || !result?.available)
    return {
      tone: 'quiet',
      label: 'Health unknown',
      count: 0,
      title: unknown ?? 'Health is unknown.',
    }
  const { findings } = result.view
  const crit = findings.filter((f) => f.state === 'crit').length
  const warn = findings.filter((f) => f.state === 'warn').length
  if (crit > 0)
    return {
      tone: 'danger',
      label: `Health: ${crit} critical`,
      count: crit + warn,
      title: `Health: ${crit} critical${warn ? `, ${plural(warn, 'warning')}` : ''}`,
    }
  if (warn > 0)
    return {
      tone: 'warn',
      label: `Health: ${plural(warn, 'warning')}`,
      count: warn,
      title: `Health: ${plural(warn, 'warning')}`,
    }
  return { tone: 'good', label: 'Health OK', count: 0, title: 'Health OK' }
}

/** Who has a finding, in the owner's words. */
export function handledBy(finding: HealthFinding): string {
  if (finding.owner) return 'Needs your call. You answer it in Nightshift.'
  if (finding.who === 'Agent') return 'A steward agent is on it.'
  if (finding.who === 'Nightshift') return 'Nightshift fixes this itself.'
  return 'Nightshift is watching it.'
}

/** `2 min left`, for an approval. */
export function leftText(seconds: number): string {
  return `${ageText(seconds)} left`
}
