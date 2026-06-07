// The one place TUIs are enumerated: a single list that onboards every TUI. The
// tray menu and launch path read the registry, so a new tool surfaces everywhere
// by adding its spec to the builtin list below — no other edits.

import type { TuiSpec } from './spec'
import { claudeCodeTui } from './tuis/claude-code'
import { codexTui } from './tuis/codex'
import { geminiTui } from './tuis/gemini'
import { hermesTui } from './tuis/hermes'
import { opencodeTui } from './tuis/opencode'
import { piTui } from './tuis/pi'
import { shellTui } from './tuis/shell'

const registry = new Map<string, TuiSpec>()

/** Onboard a TUI. Throws on a duplicate slug so collisions fail loudly. */
export function registerTui(spec: TuiSpec): void {
  if (registry.has(spec.slug)) throw new Error(`duplicate TUI slug: ${spec.slug}`)
  registry.set(spec.slug, spec)
}

export function getTui(slug: string): TuiSpec | undefined {
  return registry.get(slug)
}

/** Enabled TUIs in tray order. */
export function listTuis(): TuiSpec[] {
  return [...registry.values()].filter((s) => s.enabled).sort((a, b) => a.order - b.order)
}

/** The default TUI for a new widget (lowest-order enabled tool). */
export function defaultTui(): TuiSpec {
  const tuis = listTuis()
  if (!tuis.length) throw new Error('no TUIs registered')
  return tuis[0]
}

/** Idempotent: registers the built-in TUIs exactly once. Add new tools here. */
export function registerBuiltinTuis(): void {
  if (registry.size > 0) return
  for (const spec of [claudeCodeTui, codexTui, opencodeTui, geminiTui, piTui, hermesTui, shellTui])
    registerTui(spec)
}

/** Test-only: reset the registry between cases. */
export function clearRegistry(): void {
  registry.clear()
}
