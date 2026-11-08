// The one rule for what reaches the phone (owner 2026-11-07: "only interrupt me when an agent
// truly needs me or there is a major issue"). A notice reaches the phone only when its sender
// names one of these reasons in `interrupt`, or it is Aico's own morning digest. Severity never
// routes: a warning or critical without a reason stays in the tray and the digest. The reason is
// stored on the notice (`phone_reason`) so an audit can say why each push went out. Senders decide
// what counts as one of these in their own domain (Status: status/src/major.ts); this file only
// holds the list and the words. The owner's choice in Settings > Notifications beats this rule and
// every sender (choices.ts).

export const INTERRUPTS = ['needs-you', 'security', 'data-risk', 'outage', 'reminder'] as const
export type Interrupt = (typeof INTERRUPTS)[number]

/** Why each reason reaches the phone, in one line. */
export const PHONE_REASONS: Record<Interrupt | 'digest', string> = {
  'needs-you': 'An agent or an approval is waiting on you.',
  security: 'A security event.',
  'data-risk': 'A backup is failing or long overdue.',
  outage: 'An always-on host or service has been down for a while.',
  reminder: 'A reminder you set.',
  digest: 'Your morning digest, once a day.',
}

/** An agent's test, by what it says it is: a test sender or key, or a title that starts with TEST. */
const TEST_TITLE =
  /^test(\s+(ignore|toast|only))?\s*(\(\w+\))?\s*:|^test(ing)?\s+(the\s+)?(notification|notice|push|phone|toast|alert)s?\b/i
/** Where agents' tests have come from (sources like zz-toast-test, keys like m92b or pushcheck). */
const TEST_NAME = /^zz-|(^|-)test(-|$)|-proof$|-drill$|^pushcheck$|^m\d+[a-z]?\d*$/
/** The documented phone test: `aico notify --interrupt needs-you --title 'Test: ...'`. */
const PHONE_TEST_TITLE = /^test:/i

export function isTestNotice(source: string, keyPrefix: string, title: string): boolean {
  return TEST_NAME.test(source) || TEST_NAME.test(keyPrefix) || TEST_TITLE.test(title)
}

/** A test that may not reach the phone: anything but the documented phone test. */
export function testStaysOffPhone(source: string, key: string | undefined, title: string): boolean {
  return isTestNotice(source, key?.split(':')[0] ?? '', title) && !PHONE_TEST_TITLE.test(title)
}

/** Aico's own morning digest: the one info notice the owner approved for the phone. */
export function isDigest(source: string, kind: string, key: string | undefined): boolean {
  return source === 'aico' && kind === 'info' && key?.startsWith('digest:') === true
}

/**
 * The one rule for what pops up on the desktop (owner 2026-11-07: "don't waste my time with
 * unnecessary distractions"). It is the phone's rule: a corner card is for a notice that names a
 * reason to interrupt (`interrupt`, which includes a Status row that major.ts escalated after its
 * sustained window), or that asks the owner something (a todo or a question, which are also in
 * Needs you). Severity alone never pops, critical included: a failing check or a late row stays in
 * Status and in the tray's list without a card. An info or ok never pops either; an ok is a
 * recovery or "nothing left to do", which ends the earlier notice and says nothing new. The tray
 * door (web-server tray.ts) applies this to what it logs for the corner.
 */
export function popsUp(notice: {
  kind: string
  severity: string
  interrupt?: Interrupt | undefined
}): boolean {
  if (notice.severity !== 'warning' && notice.severity !== 'critical') return false
  return notice.interrupt !== undefined || notice.kind === 'todo' || notice.kind === 'question'
}
