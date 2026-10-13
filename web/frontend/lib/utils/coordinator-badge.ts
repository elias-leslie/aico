/** Session fields Tether's coordinator lineage arrives in (see the backend
 * session catalog and tether docs/api-v1.md Coordinators). */
export interface CoordinatorFields {
  task?: string | null
  is_coordinator?: boolean
  coordinator_id?: string | null
  coordinator_name?: string | null
  coordinator_color?: string | null
}

/** The chip before a session's title, as Aico draws it. */
export interface CoordinatorBadgeInfo {
  label: string
  color: string
}

/** Aico's original coordinator blue, for a coordinator or lane without a colour. */
const DEFAULT_COLOR = '#6fa8ff'
const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** `Coordinator` on a coordinator, `↳ <its coordinator>` on a lane, else none. */
export function getCoordinatorBadge(
  session: CoordinatorFields | null | undefined,
): CoordinatorBadgeInfo | null {
  if (!session) return null
  const color =
    session.coordinator_color && HEX_COLOR.test(session.coordinator_color)
      ? session.coordinator_color
      : DEFAULT_COLOR
  if (session.is_coordinator) return { label: 'Coordinator', color }
  if (session.coordinator_id)
    return { label: `↳ ${session.coordinator_name || 'Coordinator'}`, color }
  return null
}
