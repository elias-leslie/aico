// The universal TUI contract. A TUI is pure data — a `TuiSpec` — never a class
// with its own launch logic. The engine (launch.ts + context.ts) consumes specs
// and NEVER branches on slug, so adding a TUI is one spec object + one line in
// the builtin list (registry.ts), not new control flow: one contract, one
// registry, one engine. Tools are declarative entries; cross-cutting behavior is
// shared.

/** Declarative reference to a SHARED supplemental-context mechanism. Each
 * `kind` is implemented exactly once in context.ts and reused by every TUI that
 * declares it — so a new Claude-family TUI reuses `claude-session-start` rather
 * than reimplementing delivery. Aico independently verifies the source chain
 * and live Agent Hub delivery availability through each TUI's hook surface; it
 * does not claim what an already-running session received. Failure stays visible
 * but never blocks the native TUI/model. The surface differs per family, so
 * `kind` selects it. */
export type ContextHook =
  | { kind: 'claude-session-start' }
  | { kind: 'codex-hooks' }
  | { kind: 'pi-extension' }
  /** Antigravity: Aico's launch delivery, an AGENTS.md in an added directory. */
  | { kind: 'agy-agents-md' }
  /** A Blank Slate session (blank-slate.ts): no supplemental context by design. */
  | { kind: 'blank-slate' }

/** Outcome of verifying/ensuring a TUI's context hook. */
export type ContextState = 'available' | 'missing' | 'unsupported' | 'not_applicable'

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
  /** Declarative supplemental-context path; omitted for a bare shell. */
  context?: ContextHook
  /** Native resume capability. The owner validates the opaque session ID with
   * this adapter's pattern and appends only these fixed arguments before the
   * session ID, then `--` and the transient recovery prompt. No caller argv. */
  resume?: {
    sessionIdPattern: RegExp
    arguments: string[]
    /** Fixed arguments that start a fresh conversation under an ID Tether
     * picks, for a tool whose running process names no session (Pi). */
    freshArguments?: string[]
  }
  /** Fixed CLI flags that add a session's chosen instructions (instructions.ts)
   * to the tool's own prompt: `arguments` then the content, or with `key`,
   * `arguments` then `key='''content'''` (a TOML literal string). */
  instructions?: { arguments: string[]; key?: string }
  /** Set per session by `withInstructions`: the snapshot file each launch reads. */
  chosenInstructions?: { file: string; label: string }
  /** How the tool takes Aico's context delivery (delivery.ts): `claude-md`, a
   * CLAUDE.md in a directory added with `arguments` (and `env`); `config`,
   * `arguments` then `key=<TOML string>`; `file`, `arguments` then a file whose
   * text the tool appends to its system prompt; `agents-md`, an AGENTS.md in a
   * directory added with `arguments` (Antigravity reads it like a workspace's own). */
  contextDelivery?:
    | { kind: 'claude-md'; arguments: string[]; env: Record<string, string> }
    | { kind: 'config'; arguments: string[]; key: string }
    | { kind: 'file'; arguments: string[] }
    | { kind: 'agents-md'; arguments: string[] }
  /** Set per launch by `withContextDelivery`: the shell words and environment
   * that hand this launch's delivery to the tool. `instructions`: the chosen
   * instructions are in the delivery, so the launch adds no second copy. */
  deliveredContext?: {
    arguments: string[]
    env: Record<string, string>
    instructions: boolean
    hash: string
    bytes: number
  }
  /** Arguments the launch line adds when `command` lacks them (Pi's `--approve`). */
  ensureArgs?: string[]
  /** Launch settings travel in AICO_ROOT_* variables the tool's extension reads (Pi). */
  environmentSelection?: boolean
  /** How the agent draws its input line, for reading whether it holds a draft
   * (wakes.ts `inputLineEmpty`): a prompt mark (`❯`, `›`, `>`) by default, or
   * `ruled` for an editor drawn between two full-width rules with no mark (Pi). */
  inputLine?: 'prompt' | 'ruled'
  /** Fixed CLI flags for per-launch model overrides; never caller-supplied argv. */
  modelSelection?: {
    model: string[]
    /** A provider/model selection is required when this native flag is declared. */
    modelProvider?: string[]
    /** `values`: the levels the tool accepts; without it, the shape of the flag decides
     * (a `key` config: none..max, a plain flag: off..max). */
    reasoningEffort?: { arguments: string[]; key?: string; values?: string[] }
    /** `environment`: the tool's extension reads it from AICO_ROOT_DAYBREAK; `model`: the only model it is valid with. */
    daybreak?: { arguments: string[]; key: string } | { environment: true; model?: string }
    /** Fixed flags that print the models this host can run as a table whose
     * first two columns are provider and model, under a `provider` header. */
    listModels?: string[]
  }
}
