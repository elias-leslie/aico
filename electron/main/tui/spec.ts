// The universal TUI contract. A TUI is pure data — a `TuiSpec` — never a class
// with its own launch logic. The engine (launch.ts + context.ts) consumes specs
// and NEVER branches on slug, so adding a TUI is one spec object + one line in
// the builtin list (registry.ts), not new control flow: one contract, one
// registry, one engine. Tools are declarative entries; cross-cutting behavior is
// shared.

/** Declarative reference to a SHARED context-injection mechanism. Each `kind`
 * is implemented exactly once in context.ts and reused by every TUI that
 * declares it — so a new Claude-family TUI reuses `claude-session-start` rather
 * than reimplementing hook injection. Aico delivers mandates through each TUI's
 * own hook surface; that surface differs per family, the `kind` selects it. */
export type ContextHook =
  | { kind: 'claude-session-start' }
  | { kind: 'codex-hooks' }
  | { kind: 'gemini-hooks' }
  | { kind: 'pi-extension' }
  | { kind: 'hermes-shell-hooks' }

/** Outcome of verifying/ensuring a TUI's context hook. */
export type ContextState = 'ok' | 'missing'

export interface ContextStatus {
  state: ContextState
  detail: string
}

/** Everything that defines a TUI. Pure data: command, detection name, UI
 * metadata, optional per-TUI env, and an optional declarative context hook. */
export interface TuiSpec {
  /** Stable identifier, stored on the widget row. */
  slug: string
  /** Tray/menu label. */
  displayName: string
  /** Inline SVG titlebar mark, a simplified take on the tool's recognizable
   * brand symbol. Drawn in `accent` between Aico's two eyes so a widget's TUI
   * reads at a glance without the name. Uses `currentColor` (fill/stroke) so the
   * renderer can tint it via the accent, and renders in a fixed box so it never
   * morphs with the terminal font. Static, developer-authored markup — the
   * renderer injects it with innerHTML (never user input; see wireTitle). */
  icon: string
  /** Per-TUI accent (Lantern palette); drives the titlebar icon and future
   * per-widget tinting. */
  accent: string
  /** Tray ordering (ascending). */
  order: number
  /** Hidden from the tray when false, but still resolvable by slug. */
  enabled: boolean
  /** argv run inside the tmux session, including safe default flags. Opaque —
   * dangerous approval-bypass flags must never be hidden here. Empty for shell. */
  command: string[]
  /** Process name for pane detection (Codex leaves pane cmd as the shell). */
  processName: string
  /** Extra env exported before the command (most TUIs need none). */
  env?: Record<string, string>
  /** Declarative mandate-injection hook; omitted for a bare shell. */
  context?: ContextHook
}
