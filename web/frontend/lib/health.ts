// The Health panel's words and tones, from Nightshift's owner view
// (web/server src/nightshift.ts composes it from Nightshift's GET /api/items).
// Nightshift decides every state; this only says it. Unknown is never OK.

/** A board state, as Nightshift names it. */
export type CheckState = 'ok' | 'note' | 'warn' | 'crit' | 'unkn'

export interface HealthTile {
  id: string
  label: string
  state: CheckState
  summary: string
  /** Seconds a problem has been open (an OK tile: since its result), when known. */
  age: number | null
  /** Seconds since the shown result was observed: how old the data is. */
  checked?: number | null
  link: string
}

export interface HealthFinding {
  id: string
  host: string
  host_label: string
  check: string
  state: CheckState
  summary: string
  /** 'You', 'Agent' (only while an agent's hand-off is open), 'Nightshift', 'Daily pass' or ''. */
  who: string
  owner: boolean
  /** Nightshift's work class: auto, record, daily, now or owner. Older Nightshift: absent. */
  class?: string
  /** What is actually happening to it, in the owner's words ("Queued for tonight's pass."). Older Nightshift:
   * absent. */
  handled?: string
  /** What Nightshift or its agent does next ('' for the owner's own calls). */
  next: string
  /** Seconds the problem has been open. */
  age: number | null
  /** Seconds since its result was observed. */
  checked?: number | null
  /** The owner calls it holds, counted like needs_you. */
  calls?: number
  /** False when its owner calls are plain alerts (tripwire, sudo, canary):
   * something to check, nothing to answer. Older Nightshift: absent. */
  answerable?: boolean
  link: string
}

export interface HealthApproval {
  id: string
  title: string
  url: string
  /** Seconds left to approve. */
  left: number
}

/** An open alert or to-do from an agent or a project: not a host check, so the
 * board has no row for it. */
export interface HealthOpenItem {
  id: string
  title: string
  /** Who sent it ('summitflow', 'neri'); '' when unknown. */
  source: string
  state: 'needs_you' | 'open' | 'on_it' | 'unknown'
  /** Seconds since it was first raised. */
  age: number | null
  link: string
}

export interface NightshiftOwnerView {
  version: 1
  snapshot: {
    state: 'fresh' | 'stale' | 'missing'
    /** Seconds since the checks ran, as of when the view was read. */
    age: number | null
    /** Past this many seconds a snapshot is stale (Nightshift's own limit). Older Nightshift: absent. */
    stale_after?: number
  }
  /** When the checks last ran (ISO). Lets the age keep moving after the view was read. */
  generated_at?: string | null
  verdict: { state: string; label: string; reason: string; doing: string }
  tiles: HealthTile[]
  findings: HealthFinding[]
  /** Open alerts and to-dos that are not host findings. Older web server: absent. */
  others?: HealthOpenItem[]
  needs_you: number
  approvals: HealthApproval[]
  links: { status: string; needs_you: string; notices: string }
}

export type NightshiftViewResult =
  | { available: true; view: NightshiftOwnerView }
  | {
      available: false
      reason:
        | 'not_configured'
        | 'not_answering'
        | 'unexpected'
        | 'store_refused'
        | 'store_stale'
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
  store_refused: 'Nightshift can’t read its item store, so health is unknown.',
  store_stale:
    'Nightshift hasn’t updated its item store recently, so health is unknown.',
}

/** The checks' age and state as of `nowMs`. The view was read some time ago
 * and the live feed only speaks when something changes, so the age is counted
 * from when the checks ran, and a snapshot that has outlived Nightshift's own
 * limit reads stale instead of fresh. */
export function currentSnapshot(
  view: NightshiftOwnerView,
  nowMs: number,
): NightshiftOwnerView['snapshot'] {
  const { snapshot } = view
  const ran = view.generated_at ? Date.parse(view.generated_at) : Number.NaN
  if (snapshot.state === 'missing' || !Number.isFinite(ran)) return snapshot
  const age = Math.max(0, (nowMs - ran) / 1000)
  const outlived = snapshot.stale_after != null && age > snapshot.stale_after
  return {
    ...snapshot,
    age,
    state: snapshot.state === 'fresh' && outlived ? 'stale' : snapshot.state,
  }
}

/** Why health is unknown right now, or null when the view is current. */
export function unknownReason(
  result: NightshiftViewResult | undefined,
  loadFailed: boolean,
  nowMs: number = Date.now(),
): string | null {
  if (!result) return loadFailed ? 'Couldn’t load health.' : null
  if (loadFailed)
    return 'Couldn’t refresh health, so what’s shown may be out of date.'
  if (!result.available) return UNAVAILABLE[result.reason]
  const snapshot = currentSnapshot(result.view, nowMs)
  if (snapshot.state === 'missing')
    return 'Nightshift hasn’t reported a check yet, so health is unknown.'
  if (snapshot.state === 'stale')
    return `Nightshift’s last check was ${ageText(snapshot.age)} ago, so health is unknown until it reports again.`
  return null
}

export interface PillState {
  tone: Tone
  /** Short, beside the count: fits the phone's session sheet. */
  label: string
  /** Problems to count on the icon (critical and warnings). */
  count: number
  /** The full sentence, for the tooltip and screen readers. */
  title: string
}

/** The Health entry: Health OK, Health with a problem count, Health unknown. */
export function pillState(
  result: NightshiftViewResult | undefined,
  loadFailed: boolean,
  loading: boolean,
  nowMs: number = Date.now(),
): PillState {
  if (!result && loading && !loadFailed)
    return {
      tone: 'quiet',
      label: 'Health',
      count: 0,
      title: 'Health · loading',
    }
  const unknown = unknownReason(result, loadFailed, nowMs)
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
      label: 'Health',
      count: crit + warn,
      title: `Health: ${crit} critical${warn ? `, ${plural(warn, 'warning')}` : ''}`,
    }
  if (warn > 0)
    return {
      tone: 'warn',
      label: 'Health',
      count: warn,
      title: `Health: ${plural(warn, 'warning')}`,
    }
  return { tone: 'good', label: 'Health OK', count: 0, title: 'Health OK' }
}

/** `checked 4 min ago · open 17 days`: how old the data is, apart from how
 * long the problem has been open. */
export function whenText(
  checked: number | null | undefined,
  open: number | null | undefined,
): string {
  return [
    checked != null ? `checked ${ageText(checked)} ago` : null,
    open != null ? `open ${ageText(open)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The Nightshift calls line; it adds up with the problems listed below it. */
export function callsText(view: NightshiftOwnerView): string {
  const total = view.needs_you
  const listed = view.findings.reduce((n, f) => n + (f.calls ?? 0), 0)
  const head = `Nightshift has ${plural(total, 'call')} waiting for you`
  if (listed === total) return `${head}.`
  return listed === 0
    ? `${head}, none in the problems below.`
    : `${head}, ${listed} in the problems below.`
}

/** Who has a finding, in the owner's words. */
export function handledBy(finding: HealthFinding): string {
  if (finding.owner && finding.answerable === false)
    return 'Look at it in Nightshift. There is nothing to answer.'
  if (finding.owner)
    return (finding.calls ?? 1) > 1
      ? `${finding.calls} calls for you here. You answer them in Nightshift.`
      : 'Needs your call. You answer it in Nightshift.'
  if (finding.handled) return finding.handled
  // Older Nightshift: 'Agent' meant only that no rule fixes it, never that an agent was working on it.
  if (finding.who === 'Agent') return 'No automatic fix yet.'
  if (finding.who === 'Nightshift') return 'Nightshift fixes this itself.'
  return 'Nightshift is watching it.'
}

/** `2 min left`, for an approval. */
export function leftText(seconds: number): string {
  return `${ageText(seconds)} left`
}

/** Who raised an open item and how long ago, for its second line. */
export function openItemMeta(item: HealthOpenItem): string {
  return [
    item.source,
    item.state === 'needs_you' ? 'needs you' : null,
    item.state === 'on_it' ? 'someone is on it' : null,
    item.state === 'unknown' ? 'state unknown' : null,
    item.age != null ? `open ${ageText(item.age)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
