import { compactRef, type SelectionRecord } from './selection'
import { activePaneIdTargetArgs, sendTextTargetArgs, type TmuxTarget } from './tmux'

/** Pin an external session's active pane; later sends never follow a new active pane. */
export async function resolveActiveSelectionPane(
  session: TmuxTarget,
  run: (args: string[]) => Promise<string>,
): Promise<TmuxTarget> {
  const paneId = (await run(activePaneIdTargetArgs(session))).trim()
  if (!/^%\d+$/.test(paneId)) throw new Error('external selection pane id is invalid')
  return { ...session, session: paneId }
}

export interface SelectionDeliveryLease {
  /** Resolve an external session to an exact pane before sending. */
  target: TmuxTarget | Promise<TmuxTarget>
  isCurrent(): boolean
  delivered(records: SelectionRecord[]): void
  release(): void
}

/** Release a lifecycle owner if constructing its tmux target fails or declines. */
export function createSelectionDeliveryLease(
  create: () => SelectionDeliveryLease | null,
  releaseOwner: () => void,
): SelectionDeliveryLease | null {
  let lease: SelectionDeliveryLease | null
  try {
    lease = create()
  } catch (error) {
    releaseOwner()
    throw error
  }
  if (!lease) releaseOwner()
  return lease
}

/** Keep one lifecycle lease through the tmux command and suppress stale UI work. */
export async function deliverSelectionToPane(
  records: SelectionRecord[],
  acquire: () => SelectionDeliveryLease | null,
  runSend: (args: string[]) => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  const usable = records.filter((record) => record?.kind && record.kind !== 'empty')
  if (!usable.length) return
  let lease: SelectionDeliveryLease | null
  try {
    lease = acquire()
  } catch (error) {
    onFailure(error)
    return
  }
  if (!lease) return
  try {
    const target = await lease.target
    if (!lease.isCurrent()) return
    await runSend(sendTextTargetArgs(target, compactRef(usable)))
    if (lease.isCurrent()) lease.delivered(usable)
  } catch (error) {
    onFailure(error)
  } finally {
    lease.release()
  }
}
