// The one rule for what reaches the phone (owner 2026-11-07: "only interrupt me when an agent
// truly needs me or there is a major issue"). A notice reaches the phone only when its sender
// names one of these reasons in `interrupt`, or it is Aico's own morning digest. Severity never
// routes: a warning or critical without a reason stays in the tray and the digest. The reason is
// stored on the notice (`phone_reason`) so an audit can say why each push went out. Senders decide
// what counts as one of these in their own domain (Status: status/src/major.ts); this file only
// holds the list and the words.

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

/** Aico's own morning digest: the one info notice the owner approved for the phone. */
export function isDigest(source: string, kind: string, key: string | undefined): boolean {
  return source === 'aico' && kind === 'info' && key?.startsWith('digest:') === true
}
