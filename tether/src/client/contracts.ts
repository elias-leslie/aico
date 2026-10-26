// Tether's v1 wire contracts as its clients see them (docs/api-v1.md), and the
// pure parsers that validate untrusted answers. Daemon types come in by
// `import type` only, so a client bundle never pulls in daemon code.

import type { GuiMutationCommand as DaemonGuiMutation } from '../gui-channel'
import type { SessionStatus } from '../lifecycle/engine'
import type { ResizeRefusal } from '../lifecycle/interactive-tmux'
import type { SessionOrigin } from '../markers'
import type { SizeHolder, ViewerLabel } from '../size-holder'

export type { ResizeRefusal, SessionOrigin, SessionStatus, SizeHolder, ViewerLabel }

/** Lowest Tether API version these clients need (GET /v1/version): 2 accepts
 * the resize claim's viewer label, 3 session wakes and End's `keepWakes`. */
export const MIN_TETHER_API_VERSION = 3
/** The API version Aico's clients speak; Tether must still accept it. */
export const AICO_TETHER_API_VERSION = 1

/** Tether's check of a session's Agent Hub context hook (docs/api-v1.md). */
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
  /** Absent from a Tether older than the context-hook field. */
  contextHook?: ContextHook
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
  /** Tether's title, `Project — Task` (docs/api-v1.md "Display title and
   * badge"); absent from an older Tether. */
  displayTitle?: string
  /** The titlebar chip, worded and coloured by Tether. */
  badge?: { kind: 'coordinator' | 'child'; text: string; color: string } | null
  /** Pending wakes (scheduled check-ins), oldest first; absent from an older Tether. */
  wakes?: SessionWake[]
  /** Present on a 202 create: why the session is not running yet. */
  failure?: { code: string; reason?: string } | null
}

/** A session's pending wake as its descriptor carries it. */
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
}

export interface TetherProject {
  id: string
  name: string
  root: string
  /** SummitFlow's active project (`st projects active`); absent from older Tether. */
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

/** The `session.resized` event's data: the new size holder. `viewer` is
 * absent when the claimer sent none (an older client). */
export interface SessionResized {
  id: string
  generation: string
  clientPid: number
  cols: number
  rows: number
  changed: boolean
  viewer?: ViewerLabel
}

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

export function parseContextHook(value: unknown): ContextHook | null {
  const hook = value as Record<string, unknown> | null
  if (
    !hook ||
    typeof hook !== 'object' ||
    typeof hook.state !== 'string' ||
    typeof hook.detail !== 'string' ||
    typeof hook.tool !== 'string' ||
    typeof hook.applicable !== 'boolean'
  )
    return null
  return {
    state: hook.state,
    detail: hook.detail,
    tool: hook.tool,
    applicable: hook.applicable,
    checkedAt: typeof hook.checkedAt === 'number' ? hook.checkedAt : null,
  }
}

/** The descriptor a session event carries (`data.session`), or null when the
 * event has none (an older Tether) or it does not match the event's id. */
export function eventSession(event: TetherEvent): SessionDescriptor | null {
  const session = event.data.session as Partial<SessionDescriptor> | undefined
  if (
    !session ||
    typeof session !== 'object' ||
    typeof session.id !== 'string' ||
    session.id !== event.data.id ||
    typeof session.generation !== 'string' ||
    typeof session.status !== 'string' ||
    typeof session.tool !== 'string' ||
    typeof session.createdAt !== 'number' ||
    !session.tmux ||
    typeof session.tmux !== 'object'
  )
    return null
  return session as SessionDescriptor
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
  return { generation: value.generation, argv: value.argv, env: value.env }
}

export type GuiMutationCommand = DaemonGuiMutation & { commandId: string }

export type GuiCommand = GuiMutationCommand | { commandId: string; kind: 'layout' }

/** The GUI's verdict for one command: applied (a layout read carries the
 * GUI's own snapshot), or a stable error code. */
export type GuiVerdict = { applied: true; layout?: unknown } | { applied: false; error: string }

/** Validate one GUI channel command line. */
export function parseGuiCommand(value: unknown): GuiCommand | null {
  const line = value as Record<string, unknown> | null
  if (line?.type !== 'command' || typeof line.commandId !== 'string') return null
  if (line.kind === 'layout') return { commandId: line.commandId, kind: 'layout' }
  if (
    (line.kind !== 'show' &&
      line.kind !== 'position' &&
      line.kind !== 'title' &&
      line.kind !== 'coordinator') ||
    typeof line.sessionId !== 'string' ||
    !/^[0-9a-f]{8}$/.test(line.sessionId) ||
    typeof line.generation !== 'string'
  )
    return null
  const command: GuiMutationCommand = {
    commandId: line.commandId,
    kind: line.kind,
    sessionId: line.sessionId,
    generation: line.generation,
  }
  if (line.kind === 'position') {
    const b = line.bounds as Record<string, unknown> | null
    const int = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n)
    if (!b || !int(b.x) || !int(b.y) || !int(b.width) || !int(b.height)) return null
    command.bounds = {
      x: b.x as number,
      y: b.y as number,
      width: b.width as number,
      height: b.height as number,
    }
  }
  if (line.kind === 'title') {
    if (typeof line.label !== 'string') return null
    command.label = line.label
  }
  if (line.kind === 'coordinator') {
    if (typeof line.coordinator !== 'boolean') return null
    command.coordinator = line.coordinator
  }
  if (line.kind === 'show' && line.ifViewed === true) command.ifViewed = true
  return command
}
