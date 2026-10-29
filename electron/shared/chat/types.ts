// What an Agent Hub chat view and whatever carries its I/O (Electron's preload
// bridge, the web app's HTTP) say to each other. Nothing here knows where Agent
// Hub is or who the owner is.

/** What the chat view is told about the session it shows. */
export interface ChatInfo {
  /** The Agent Hub session id the chat panel opens. */
  sessionId: string
  agentSlug: string
  requestedModel: string | null
  /** The git branch the session's folder has checked out, when it has one. */
  branch?: string
  /** A workflow step's attempt, read only: the view offers no message box. */
  readOnly?: boolean
}

/** A failure as the view rebuilds it into an SDK-shaped error. */
export interface ChatFailure {
  message: string
  /** Tether's or Agent Hub's code (`agent_hub_unavailable`, `turn_running`, ...). */
  code: string
  status?: number
}

export type ChatCallResult = { ok: true; value: unknown } | { ok: false; error: ChatFailure }

/** One item of a stream: a turn event as Agent Hub sent it, or how the stream ended. */
export type ChatStreamItem =
  | { kind: 'event'; event: Record<string, unknown> }
  | { kind: 'end' }
  | { kind: 'error'; error: ChatFailure }

/** The chat view's only way out: one request at a time, and the running turn's events. */
export interface ChatTransport {
  /** One request for the session this transport shows (methods: session, queue, send,
   * cancel, models). Never throws. */
  call(method: string, args: Record<string, unknown>): Promise<ChatCallResult>
  /** Follow the running turn from `afterSeq`: items arrive until the turn ends or the
   * returned function closes the stream. */
  openStream(afterSeq: number, onItem: (item: ChatStreamItem) => void): Promise<() => void>
}
