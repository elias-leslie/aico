// Tether's v1 wire contracts as its clients see them (docs/api-v1.md), and the
// pure parsers that validate untrusted answers. The few daemon types the wire
// carries are defined here, and the daemon imports them from this package, so a
// client bundle never pulls in daemon code.

/** `pending`: never allocated; `uncertain`: not proven running (a lifecycle-v0
 * row is never proven). */
export type SessionStatus = 'running' | 'pending' | 'uncertain'

/** Why a resize claim was not applied (docs/api-v1.md). `client_not_attached`
 * and `stale` are retryable; `window_linked` and `status_row` are permanent. */
export type ResizeRefusal =
  | 'invalid'
  | 'stale'
  | 'client_not_attached'
  | 'window_linked'
  | 'status_row'

export type SessionOrigin = 'aico' | 'a-term' | 'root' | 'cli'

/** Which app on which device made a claim (`{app: 'web', device: 'Chrome on Linux'}`),
 * so the other views can say where the session is being viewed. */
export interface ViewerLabel {
  app: string
  device: string
}

export interface SizeHolder {
  clientPid: number
  cols: number
  rows: number
  /** The session generation the claim was made on. */
  generation: string
  claimedAt: string
  /** Null when the claimer sent no label (an older client). */
  viewer: ViewerLabel | null
}

/** Lowest Tether API version these clients need (GET /v1/version): 2 accepts
 * the resize claim's viewer label, 3 session wakes and End's `keepWakes`. */
const MIN_TETHER_API_VERSION = 3
/** The Tether API version this release was written against (packages/tether's API_VERSION, which
 * a test keeps equal). A daemon reporting less is older than the web server expects. */
export const EXPECTED_TETHER_API_VERSION = 32
/** The API version Aico's clients speak; Tether must still accept it. */
const AICO_TETHER_API_VERSION = 1

/** Tether's check of a session's context hook (docs/api-v1.md). */
export interface ContextHook {
  /** `available`, `missing`, `unsupported`, `not_applicable` or `unknown`. */
  state: string
  detail: string
  tool: string
  /** False for a tool with no context mechanism (a bare shell). */
  applicable: boolean
  checkedAt: number | null
}

export interface SessionDescriptor {
  id: string
  ownershipId: string
  generation: string
  status: SessionStatus
  available: boolean
  tool: string
  name: string | null
  /** What the tool running in it calls the conversation (or its first prompt), used when no name was
   * typed; absent from an older Tether. */
  autoName?: string | null
  /** The task part of `displayTitle` (the typed name, else `autoName`...), without the project. */
  taskName?: string | null
  /** What a working agent is doing now, one line; null when it is not working. */
  doing?: string | null
  label: string
  projectId: string | null
  projectRoot: string | null
  origin: SessionOrigin
  rootRequestId: string | null
  lifecycleVersion: number
  tmux: {
    serverId: string | null
    socket: string | null
    sessionId: string | null
    paneId: string | null
    sessionName: string
  }
  createdAt: number
  /** The native conversation ID last observed for a Claude Code or Codex session; only on
   * `GET /v1/sessions/:id`, null when none is known, absent from an older Tether. */
  resumeId?: string | null
  /** Absent from a Tether older than the context-hook field. */
  contextHook?: ContextHook
  /** The prompt revision chosen at creation, or null; absent from
   * an older Tether. Never the content. */
  instructions?: {
    prompt: string
    name: string
    revision: string
    contentHash: string | null
    createdAt: string | null
  } | null
  /** The agent's state (tether docs/agent-state.md); absent from an older Tether. */
  state?: 'working' | 'idle' | 'blocked' | 'unknown'
  /** The state before the last change; absent from an older Tether. */
  statePrevious?: 'working' | 'idle' | 'blocked' | 'unknown'
  stateSource?: string
  stateAt?: number | null
  stateDetail?: string | null
  /** Coordinator lineage (tether docs/api-v1.md "Coordinators"); absent from
   * an older Tether. */
  coordinator?: boolean
  /** The root coordinator that launched this session. */
  coordinatorId?: string | null
  /** `#rrggbb`, on a coordinator and its lanes. */
  coordinatorColor?: string | null
  /** The session that launched this one: the root coordinator or one of its lanes (9). */
  parentId?: string | null
  /** Tether's title, `Project — Task` (docs/api-v1.md "Display title and
   * badge"); absent from an older Tether. */
  displayTitle?: string
  /** The titlebar chip, worded and coloured by Tether. */
  badge?: { kind: 'coordinator' | 'child'; text: string; color: string } | null
  /** Pending wakes (scheduled check-ins), oldest first; absent from an older Tether. */
  wakes?: SessionWake[]
  /** Open owner asks from this session, oldest first (docs/api-v1.md "Asks"); a
   * blocking one means the session needs the owner. Absent from an older Tether. */
  asks?: SessionAsk[]
  /** Present on a 202 create: why the session is not running yet. */
  failure?: { code: string; reason?: string } | null
  /** The remote host that runs this session (tether docs/api-v1.md "Remote
   * hosts"); null or absent for a session on this computer. */
  host?: string | null
  /** Present only while the owning host's link is not live: the descriptor is
   * the last one the hub saw, never proof the session is gone. */
  peer?: PeerMark | null
}

/** A child its launcher started, compared with Tether's current workload inventory. */
export interface ChildAgent {
  id: string
  parent: string
  host: string | null
  title: string
  state: 'live' | 'vanished' | 'unknown'
}

/** A remote host's link state as the hub sees it. `powered_off`: the Hosts
 * panel powered it off, or its hosts.json `status` command says it is off. */
export type HostState = 'connected' | 'connecting' | 'offline' | 'powered_off' | 'identity_changed'

/** Why a remote session's descriptor is not live, and since when. */
export interface PeerMark {
  state: Exclude<HostState, 'connected'>
  since: number
  /** When that host's session list was last fresh, or null. */
  listedAt: number | null
}

/** One remote host from `GET /v1/hosts` ("This computer" is implied, not listed). */
export interface HostInfo {
  name: string
  /** The ssh Host alias the link uses. */
  ssh: string
  /** The link's ssh ControlMaster socket (`$XDG_RUNTIME_DIR/aico/fleet/<name>/exec.sock`). */
  control: string
  /** The host's Tether state directory, when hosts.json names one. */
  stateDir?: string
  state: HostState
  since: number | null
  listedAt: number | null
  sessions: number
  error: string | null
  /** A create bringing this host up (powering on, connecting, checking its
   * services), or why that failed; null otherwise. Also on `peer.state`. */
  wake: HostWake | null
  /** hosts.json has a `sleep` command, so Aico can power the host off; absent from an older Tether. */
  canSleep?: boolean
}

export interface HostWake {
  state: 'starting' | 'failed'
  reason: 'host_starting'
  step: 'powering_on' | 'connecting' | 'checking_services'
  since: number
  error: string | null
}

/** A create on a host may first power it on and wait for it (the host's
 * `wakeTimeoutSec`, 240 s by default) before the host's own create runs. */
export const HOST_CREATE_TIMEOUT_MS = 420_000

/** A session's pending wake as its descriptor carries it. */
export interface SessionAsk {
  id: string
  question: string
  blocking: boolean
  createdAt: number
}

export interface SessionWake {
  id: string
  dueAt: number
  note: string
  createdBy: 'agent' | 'owner'
}

/** A wake as `GET /v1/wakes` lists it. A kept wake (`sessionId` null)
 * outlived its session's End and names the ended session. */
export interface Wake extends SessionWake {
  sessionId: string | null
  createdAt: number
  kept: boolean
  endedSession?: { id: string; name: string | null; tool: string; projectId: string | null }
  attempts: number
  lastError: string | null
}

/** Tether's wake policy: the apps' quick choices and the limits. */
export interface WakePolicy {
  laterMinutes: number
  tonightHour: number
  morningHour: number
  maxPerSession: number
  noteMaxChars: number
  quietSeconds: number
  lateNoticeMinutes: number
  relaunchAttempts: number
}

export interface WakeList {
  items: Wake[]
  policy: WakePolicy
}

/** The note of a check-in the owner sets from a menu (the agent reads it). */
export const OWNER_CHECK_IN_NOTE =
  'The owner asked for this check-in: say where this stands, then carry on if there is more to do.'

/** `5:30 PM`, with the weekday when it is not today. */
export function wakeClock(at: number, now: number = Date.now()): string {
  const time = new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time
  return `${new Date(at).toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

/** The menus' quick choices from the policy: "In 1 hour", "Tonight" (this
 * hour today, tomorrow once it has passed) and "Tomorrow morning". */
export function wakeChoices(
  policy: Pick<WakePolicy, 'laterMinutes' | 'tonightHour' | 'morningHour'>,
  now: number = Date.now(),
): { label: string; dueAt: number }[] {
  const at = (hour: number, days: number) => {
    const date = new Date(now)
    date.setDate(date.getDate() + days)
    date.setHours(hour, 0, 0, 0)
    return date.getTime()
  }
  const minutes = policy.laterMinutes
  const later =
    minutes % 60 === 0 ? `In ${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `In ${minutes} min`
  const tonight = at(policy.tonightHour, at(policy.tonightHour, 0) > now ? 0 : 1)
  // Before the morning hour (say 2 AM), "morning" is the coming one.
  const morning = at(policy.morningHour, at(policy.morningHour, 0) > now ? 0 : 1)
  const today = (time: number) => new Date(time).toDateString() === new Date(now).toDateString()
  return [
    { label: later, dueAt: now + minutes * 60_000 },
    { label: today(tonight) ? 'Tonight' : 'Tomorrow night', dueAt: tonight },
    { label: today(morning) ? 'This morning' : 'Tomorrow morning', dueAt: morning },
  ]
}

/** `GET /v1/sessions/:id/attach` as Tether answered it, shape-checked only.
 * The caller builds its own tmux argv and environment from it. */
export interface AttachAnswer {
  generation: string
  argv: string[]
  env: Record<string, string>
  /** The remote host of a forwarded session; absent for a local one. */
  host?: string | null
  /** How to reach that host through its link (the hub's hosts.json entry). */
  fleet?: { alias: string; control: string; stateDir?: string }
}

export interface TetherTool {
  slug: string
  name: string
  color: string | null
  /** The process Tether watches for the tool (`claude`). */
  processName?: string
  /** Other names the tool answers to (`claude` for `claude-code`). */
  aliases?: string[]
  displayOrder: number
  isDefault: boolean
  enabled: boolean
  /** It can start a Blank Slate session (`createSession({ blankSlate: true })`). */
  blankSlate?: boolean
  /** It can take chosen instructions (`createSession({ instructions })`). */
  instructions?: boolean
}

export interface TetherProject {
  id: string
  name: string
  root: string
  /** st's active project (`st projects active`); absent from older Tether. */
  current?: boolean
}

export interface TetherVersion {
  name: string
  version: string
  apiVersion: number
  minApiVersion: number
}

export interface TetherEvent {
  seq: number
  bootId: string
  /** One of Tether's event types; clients ignore types they do not know. */
  type: string
  at: number
  data: Record<string, unknown>
}

/** `POST /v1/sessions/:id/resize-claim`'s answer. `tmux_unavailable` is
 * Tether's own refusal when tmux could not be asked. */
export type ResizeClaimAnswer =
  | { applied: true; changed: boolean }
  | { applied: false; reason: ResizeRefusal | 'tmux_unavailable' }

/** A Tether answer other than 2xx. `code` is Tether's stable error code. */
export class TetherError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.reason === 'string' ? `${code}: ${body.reason}` : code)
    this.name = 'TetherError'
  }

  get reason(): string | undefined {
    return typeof this.body.reason === 'string' ? this.body.reason : undefined
  }
}

/** The socket could not be reached or the exchange broke. Nothing is known to
 * have changed; for a mutation, the outcome is unknown. */
export class TetherUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TetherUnavailable'
  }
}

/** True when Tether accepts these clients and offers what they need. */
export function compatibleVersion(version: TetherVersion): boolean {
  return (
    Number.isSafeInteger(version.apiVersion) &&
    version.apiVersion >= MIN_TETHER_API_VERSION &&
    (!Number.isSafeInteger(version.minApiVersion) ||
      version.minApiVersion <= AICO_TETHER_API_VERSION)
  )
}

/** Split complete NDJSON lines from a buffer; the incomplete tail is kept. */
export function splitNdjson(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map((line) => line.trim()).filter(Boolean), rest }
}

/** Check an attach answer's shape before anything looks at its contents. */
export function parseAttachAnswer(body: unknown): AttachAnswer {
  const value = body as Partial<AttachAnswer> | null
  if (
    !value ||
    typeof value.generation !== 'string' ||
    !Array.isArray(value.argv) ||
    !value.argv.every((item) => typeof item === 'string') ||
    !value.env ||
    typeof value.env !== 'object' ||
    !Object.values(value.env).every((item) => typeof item === 'string')
  )
    throw new TetherUnavailable('Tether returned an invalid attach target')
  // `host` and `ssh` pass through untouched; the remote attach validates them.
  return {
    generation: value.generation,
    argv: value.argv,
    env: value.env,
    ...(value.host !== undefined ? { host: value.host } : {}),
    ...(value.fleet !== undefined ? { fleet: value.fleet } : {}),
  }
}

// --- session history (docs/api-v1.md "Session history") ---------------------------

export type HistoryOutcome = 'completed' | 'aborted' | 'error'

export interface HistoryTokens {
  /** The part of the input not served from the cache. */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface HistorySession {
  id: string
  tool: 'claude-code' | 'codex' | 'pi' | 'aico-agent'
  parentId: string | null
  project: string | null
  cwd: string | null
  model: string | null
  startedAt: number | null
  endedAt: number | null
  /** null: no final answer yet (a turn is running, or the tool stopped without one). */
  outcome: HistoryOutcome | null
  tokens: HistoryTokens
  /** The latest model call's prompt tokens: the context fill (api 30); null: not read yet. */
  contextTokens?: number | null
  toolCalls: number
  filesWritten: number
  /** What the conversation is called: the tool's own name for it, else the first prompt (trimmed).
   * Absent from an older Tether; null when none is known yet. */
  title?: string | null
  /** What the agent was doing at its last record, one line; absent from an older Tether. */
  doing?: string | null
}

/** A match in a past conversation (`GET /v1/history/search`). */
export interface HistorySearchHit {
  /** Byte offset of the transcript line: `historyEvents(id, { from })` opens at it. */
  offset: number
  at: number | null
  role: 'user' | 'assistant' | 'tool' | 'system'
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'note'
  tool?: string
  snippet: string
}

export interface HistorySearchResult {
  session: HistorySession
  matches: number
  hits: HistorySearchHit[]
}

export interface HistorySearchPage {
  query: string
  items: HistorySearchResult[]
  /** The tools read; the Aico agent and agy keep nothing a search can read yet. */
  covers: HistorySession['tool'][]
  /** What was read: the conversations (newest first), the start of the oldest, the bytes. */
  searched: { sessions: number; since: number | null; bytes: number; ms: number }
  /** Older conversations were not read. */
  more: boolean
  /** Why: the limit, the read or time budget, or the caller going away. Absent from an older
   * Tether, where `more` means the limit. */
  stop?: 'limit' | 'budget' | 'cancelled' | null
}

/** One turn of an Aico agent run and the model that ran it. */
export interface HistoryTurn {
  turn: number
  model: string
  stop: string
}

/** What the Aico agent pushes at a run's start and end (`PUT /v1/history/aico-agent/:run`). */
export interface AgentRunPush {
  chat?: { title: string; state: string; updatedAt: number }
  cwd: string
  role: string | null
  startedAt: number
  /** null while a prompt runs. */
  endedAt: number | null
  outcome: HistoryOutcome | null
  tokens: HistoryTokens
  toolCalls: number
  turns: HistoryTurn[]
}

export interface HistoryDetail extends HistorySession {
  /** An Aico agent run's turns; absent for other tools. */
  turns?: HistoryTurn[]
  path: string
  files: { path: string; writes: number }[]
  subagents: { count: number; tokens: HistoryTokens; toolCalls: number }
}

export interface HistoryEvent {
  offset: number
  at: number | null
  role: 'user' | 'assistant' | 'tool' | 'system'
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'note'
  text: string
  tool?: string
  model?: string
}

export interface HistoryEventPage {
  items: HistoryEvent[]
  /** Pass as `before` for older events; null: this is the start. */
  older: number | null
  /** Pass as `from` for newer events; null: this is the end. */
  newer: number | null
  size: number
}
