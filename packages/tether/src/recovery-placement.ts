import { rootRequestForWidget } from '@aico/session-engine/catalog'
import { LOCAL_HOST, type Needs, type Placement } from './hub/placement'

/** Restore a booking before its agent can run; the placement owner retains needs. */
export async function restoreSessionReservation(
  context: { placement?: Pick<Placement, 'place' | 'restore'> },
  id: string,
  needs?: Needs,
): Promise<string | null> {
  const root = rootRequestForWidget(id)
  if (!root) return needs ? 'the session has no root to reserve' : null
  if (!context.placement) return needs ? 'placement is unavailable' : null
  const result = needs
    ? await context.placement.place(root.requestId, needs, undefined, LOCAL_HOST, true)
    : await context.placement.restore(root.requestId)
  // A root created without placement has no needs to restore. Older missing
  // bookings can be seeded once through recovery resume's explicit needs.
  if (!result) return null
  if (result.kind !== 'placed')
    return `waiting for its reservation: ${result.kind}${result.verdicts.length ? ` (${result.verdicts.map((v) => v.reason).join('; ')})` : ''}`
  result.done()
  return null
}
