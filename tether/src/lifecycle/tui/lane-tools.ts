// Lean lanes: a launched session starts without the tools and listings its
// work role never uses. Which ones is data (lane-tools.json): per tool, the
// environment every trimmed role gets and each role's extra arguments, both
// documented harness switches. The session's own work role picks the entry;
// a session nobody launched has none and starts with the full harness, as does
// a role set to false (coordinators, which publish owner-facing pages).

import LANE_TOOLS from './lane-tools.json'
import type { TuiSpec } from './spec'

interface RoleTools {
  args?: string[]
}

interface ToolProfile {
  env?: Record<string, string>
  roles: Record<string, RoleTools | false>
}

export type LaneTools = Record<string, ToolProfile | string>

/** The spec to launch for a session with this work role: the tool's lean
 * environment and the role's arguments after its own, or the spec unchanged. */
export function forRole<T extends TuiSpec | undefined>(
  spec: T,
  workRole: string | null | undefined,
  profiles: LaneTools = LANE_TOOLS as LaneTools,
): T {
  if (!spec || spec.command.length === 0 || !workRole) return spec
  const profile = profiles[spec.slug]
  if (!profile || typeof profile === 'string') return spec
  const role = Object.hasOwn(profile.roles, workRole) ? profile.roles[workRole] : profile.roles['*']
  if (!role) return spec
  return {
    ...spec,
    command: [...spec.command, ...(role.args ?? [])],
    env: { ...spec.env, ...profile.env },
  }
}
