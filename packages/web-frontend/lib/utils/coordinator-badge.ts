/** Session fields Tether's coordinator badge arrives in (see the backend
 * session catalog and tether docs/api-v1.md "Display title and badge"). */
export interface CoordinatorFields {
  task?: string | null
  badge?: { kind: string; text: string; color: string } | null
  is_coordinator?: boolean
  coordinator_id?: string | null
  /** The session that launched this one; the list nests under it. */
  parent_id?: string | null
}

/** The chip before a session's title, as Aico draws it. */
export interface CoordinatorBadgeInfo {
  label: string
  color: string
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** Tether's badge as it is (`Coordinator`, `↳ <coordinator>`); none when it
 * is missing or not well formed. */
export function getCoordinatorBadge(
  session: CoordinatorFields | null | undefined,
): CoordinatorBadgeInfo | null {
  const badge = session?.badge
  if (!badge?.text?.trim() || !HEX_COLOR.test(badge.color ?? '')) return null
  return { label: badge.text, color: badge.color }
}
