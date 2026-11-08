// The one contract every agent TUI (Claude Code, Codex, Pi, Antigravity) is
// written against. Each tool has one module in this folder that exports a
// `TuiAdapter`; registry.ts lists them, and the rest of Tether asks the
// registry, never a tool's name. A fix for one tool's behavior lives in its
// module, and conformance.test.ts runs every adapter through the same checks.
//
// Unsupported is a capability set to false, never a missing branch. Everything
// an adapter reports to the rest of the system (signals, observations, model
// events, hook facts) is plain JSON-serializable data, so a worker on a VM can
// run the same adapters and send those over the fleet link.

import type { ToolLogin } from '@aico/shared/tool-login'
import type { AgentSignal } from '../../../agent-signal'
import type { ModelEvent, ModelSource } from '../../../model-record'
import type {
  AgentObservation,
  EntryProcess,
  EntryReaders,
  FileTail,
  ProcFs,
} from '../../../proc-facts'
import type { ToolSeed } from '../../../tool-types'
import type { ContextHook, ContextStatus, TuiSpec } from '../spec'

/** The `detail` of a `working` signal whose agent finished its own turn while
 * background work (subagents, tasks) still runs: its prompt takes input, but
 * the tool still counts it busy. It stays `working` for everything that waits
 * on busy work (reboot, lane reports); only the gated wake paste treats it
 * as able to take a line (wake-runtime.ts). */
export const MAIN_TURN_OVER = 'main turn over, background work running'
/** The `stateDetail` of an idle agent whose turn is over with background shells of its own still
 * running: their finish starts its next turn, so it is not finished yet. It still takes lines. */
export const BACKGROUND_SHELLS = 'background shells running'

/** What a state search has to look with. `seams` holds per-adapter test
 * seams, keyed by adapter id. */
export interface StateContext {
  fs: ProcFs
  home: string
  pids: number[]
  tail?: FileTail
  seams?: Record<string, unknown>
  /** Runs agents push to the session history, by their own id (the Aico agent's state). */
  runs?: AgentRunLookup
}

/** A pushed run's start and end (ms), or null when it has not been pushed. */
export type AgentRunLookup = (
  runId: string,
) => { startedAt: number | null; endedAt: number | null } | null

/** The agent found in a pane: one reader of its own state. */
export interface AgentProbe {
  /** The agent's process. */
  pid: number
  /** One look at the agent's own state; null: it says nothing (unknown). */
  poll(): AgentSignal | null
  /** Where the agent keeps the record of its models, given its latest signal. */
  models?(signal: AgentSignal | null): ModelSource | null
  /** Look again between process searches (the agent's files can change within
   * a run); returns the probe to keep. */
  follow?(ctx: StateContext): AgentProbe
}

/** The state half of the contract: finding the agent and reading busy/idle. */
export interface StateDetection {
  /** Find the agent in a pane's processes; `previous` is this adapter's probe
   * from the last search, so a reader keeps its place while the file is the same. */
  find(ctx: StateContext, previous: AgentProbe | null): AgentProbe | null
  /** The same for a session that runs through an entry home. */
  findInEntry?(
    ctx: StateContext & { readers: EntryReaders; entry: EntryProcess },
    previous: AgentProbe | null,
  ): AgentProbe | null
  /** The agent's resume handle from its processes (reboot continuity). */
  observe?(fs: ProcFs, home: string, pids: number[]): AgentObservation | null
  observeInEntry?(readers: EntryReaders, entry: EntryProcess): AgentObservation | null
}

/** Per-tool facts that live outside Tether (hook scripts, extensions), kept
 * here so a change to one tool's hooks is made in one place. The Python side
 * (SummitFlow scripts/lib/coord_inbox.py `takes_ride`) must agree. */
export interface HookFacts {
  /** The provider name coord_inbox.py knows this tool by; null: none. */
  provider: string | null
  /** Hook events whose output carries Tether's ride-along lines: a new
   * prompt (next turn) or a main-agent tool result. */
  rideAlong: string[]
  /** Hook events the tool reports to Tether as state (`POST …/agent-event`). */
  stateReports: string[]
  /** What must be installed for the hooks above to run. */
  installs: { what: string; path: string }[]
}

export interface Capabilities {
  /** Starts as a root: needs a resume adapter, since a root is resumable after a crash. */
  root: boolean
  /** Has an adapter in scripts/aico-blank-slate. */
  blankSlate: boolean
  /** Takes a session's chosen instructions on top of its own prompt. */
  instructions: boolean
  /** Can run through a session entry (a container home). */
  entry: boolean
  /** The tool a session entry with no TETHER_ENTRY_TOOL marker means (launched before the marker existed). */
  entryDefault: boolean
  /** `st aico root rewind` can rewind it. */
  rewind: boolean
  /** Its hooks report state to Tether (`agent-event`). */
  stateHooks: boolean
  /** Its transcript is followed for model switches. */
  modelWatch: boolean
  /** Tether reads a finished transcript for recovery facts. */
  transcriptFacts: boolean
  /** Sets a per-thread id in subagents, so a subagent's caller can be told from the main agent. */
  threadSubagents: boolean
  /** Atomic native admin (clear/compact) is a route for it. */
  nativeAdmin: boolean
  /** Launch settings travel in AICO_ROOT_* environment variables its extension reads. */
  environmentSelection: boolean
  /** It draws its own status line (context fill, usage) under the session, so
   * Aico's header leaves the context number out. */
  statusLine: boolean
  /** How Tether delivers event lines to it. */
  delivery: {
    /** The gated paste into an idle pane. */
    idlePaste: boolean
    /** Ride-along lines taken at the start of the next turn (UserPromptSubmit). */
    nextTurn: boolean
    /** Ride-along lines taken at the main agent's next tool result. */
    toolResult: boolean
  }
}

export interface TuiAdapter {
  /** The canonical slug stored on a widget row. */
  id: string
  /** The short name the tool's own hooks and Tether's model watch use. */
  harness: string
  /** The `agent_tools` row seeded for it: command, process name, colour, … */
  seed: ToolSeed
  /** Launch settings beyond the seed's argv. */
  launch: {
    /** Arguments the launch adds when the stored command lacks them. */
    ensureArgs: string[]
  }
  /** Fields of the TuiSpec this tool declares (resume, flags, input line). */
  spec: Pick<
    TuiSpec,
    'resume' | 'instructions' | 'contextDelivery' | 'modelSelection' | 'inputLine'
  >
  capabilities: Capabilities
  /** Entry API version that first took this tool in `POST /v1/roots` `entry`; null: never. */
  entryApiVersion: number | null
  state: StateDetection
  /** Context delivery: the hook kind and the check that it is installed. */
  context: {
    kind: ContextHook
    check(spec: TuiSpec): Promise<ContextStatus>
  }
  hooks: HookFacts
  login: ToolLogin
  /** Model-switch watch: parse the tool's transcript. null when `capabilities.modelWatch` is false. */
  models: {
    events(line: string): ModelEvent[]
    /** The owner's prompt `uuid` and the prompts after it, for a rewind. */
    promptAt?(transcript: string, uuid: string): { text: string; after: string[] } | null
  } | null
  /** Where a conversation's session file is, by id; null when the tool's file
   * is found another way (Codex: the rollout its process holds open) or it keeps none. */
  sessionFile: ((fs: ProcFs, home: string, sessionId: string) => string | null) | null
  /** Words for the lane-facing advice when the tool cannot rewind. */
  displayName: string
}
