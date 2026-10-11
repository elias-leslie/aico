import { compactRef, type SelectionRecord } from './selection'

/** Where a selection goes: one session, injected through Tether. */
export interface SelectionTarget {
  /** False once the view closed or the session changed under the send. */
  isCurrent(): boolean
  /** Type the compact reference at the prompt (no Enter): Tether's
   * generation-fenced `inject` with `mode: "type"`. */
  inject(text: string): Promise<void>
  delivered(records: SelectionRecord[]): void
}

/** Deliver one compact reference for the usable records, or nothing. Tether
 * refuses a stale generation or a non-running session; nothing is retried. */
export async function deliverSelectionToSession(
  records: SelectionRecord[],
  target: SelectionTarget | null,
  onFailure: (error: unknown) => void,
): Promise<void> {
  const usable = records.filter((record) => record?.kind && record.kind !== 'empty')
  if (!usable.length || !target || !target.isCurrent()) return
  try {
    await target.inject(compactRef(usable))
    if (target.isCurrent()) target.delivered(usable)
  } catch (error) {
    onFailure(error)
  }
}
