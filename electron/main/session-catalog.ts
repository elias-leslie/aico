import type { SessionDescriptor } from 'tether/client'
import { builtinTool } from './tool-marks'

/** A session's title, Tether's `displayTitle` (`Project — Task`), else its
 * default label. The window title, tray and pickers all show this; Tether
 * owns the wording (tether docs/api-v1.md "Display title and badge"). */
export function sessionTitle(
  descriptor: Pick<SessionDescriptor, 'label'> & Partial<Pick<SessionDescriptor, 'displayTitle'>>,
): string {
  return descriptor.displayTitle?.trim() || descriptor.label
}

/** The titlebar chip, Tether's `badge` as it is (`Coordinator` or
 * `↳ <coordinator>` in the coordinator's colour); null for any other session
 * or a badge that is not well formed. */
export function coordinatorChip(
  descriptor: Partial<Pick<SessionDescriptor, 'badge'>>,
): { text: string; color: string } | null {
  const badge = descriptor.badge
  if (!badge || typeof badge.text !== 'string' || !badge.text.trim()) return null
  if (!/^#[0-9a-f]{6}$/i.test(badge.color ?? '')) return null
  return { text: badge.text, color: badge.color }
}

/** A tool's registry name (`Claude Code`), else Aico's built-in name for the
 * slug (Tether's list not loaded yet), else the slug. */
export function toolDisplayName(
  slug: string,
  tools: readonly { slug: string; name: string }[],
): string {
  return tools.find((tool) => tool.slug === slug)?.name ?? builtinTool(slug)?.name ?? slug
}

/** The tray's label for a session: its display label and tool, as the window
 * title shows them. Several sessions in one workspace otherwise share a label,
 * and the tray's End list could not tell them apart. */
export function traySessionLabel(label: string, tool: string): string {
  return tool && tool !== label ? `${label} · ${tool}` : label
}
