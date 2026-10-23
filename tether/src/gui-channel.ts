// The one GUI view channel per instance (docs/api-v1.md "GUI view-mutation
// forwarding"). Views belong to the app: Tether validates a show/position/
// title request against the exact running generation, then forwards it to the
// connected GUI and answers with the GUI's result. Layout reads use this same
// correlated channel without a session fence. Tether never starts a GUI.

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EventBus } from './events'

export interface GuiMutationCommand {
  kind: 'show' | 'position' | 'title' | 'coordinator'
  sessionId: string
  generation: string
  bounds?: { x: number; y: number; width: number; height: number }
  label?: string
  coordinator?: boolean
}

export type GuiCommand = GuiMutationCommand | { kind: 'layout' }

export type GuiOutcome =
  | { status: 'applied'; layout?: Record<string, unknown> }
  | { status: 'rejected'; error: string }
  | { status: 'unavailable' }
  | { status: 'timeout' }

interface Pending {
  resolve(outcome: GuiOutcome): void
  timer: NodeJS.Timeout
  stream: ServerResponse
  kind: GuiCommand['kind']
}

export const GUI_RESULT_TIMEOUT_MS = 5_000
const ERROR_RE = /^[a-z][a-z0-9_]{0,63}$/

export class GuiChannel {
  private stream: ServerResponse | null = null
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly events: EventBus | null,
    private readonly timeoutMs = GUI_RESULT_TIMEOUT_MS,
  ) {}

  connected(): boolean {
    return this.stream !== null && !this.stream.destroyed
  }

  /** `GET /v1/gui/channel`: a long-lived NDJSON command stream. A second
   * connection supersedes the first. */
  attach(request: IncomingMessage, response: ServerResponse, heartbeatMs = 15_000): void {
    const previous = this.stream
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    })
    this.stream = response
    if (previous && !previous.destroyed) {
      previous.end(`${JSON.stringify({ type: 'superseded' })}\n`)
      this.failPending(previous)
    }
    response.write(`${JSON.stringify({ type: 'hello' })}\n`)
    const heartbeat = setInterval(
      () => response.write(`${JSON.stringify({ type: 'heartbeat' })}\n`),
      heartbeatMs,
    )
    this.events?.publish('gui.connected', {})
    const close = () => {
      clearInterval(heartbeat)
      if (this.stream !== response) return
      this.stream = null
      this.failPending(response)
      this.events?.publish('gui.disconnected', {})
    }
    request.once('close', close)
    response.once('close', close)
  }

  /** Forward one command and wait for its result. Nothing is sent without a GUI. */
  send(command: GuiCommand): Promise<GuiOutcome> {
    const stream = this.stream
    if (!stream || stream.destroyed) return Promise.resolve({ status: 'unavailable' })
    const commandId = randomUUID()
    return new Promise<GuiOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId)
        resolve({ status: 'timeout' })
      }, this.timeoutMs)
      this.pending.set(commandId, { resolve, timer, stream, kind: command.kind })
      stream.write(`${JSON.stringify({ type: 'command', commandId, ...command })}\n`)
    })
  }

  /** `POST /v1/gui/results/:commandId`. False when the command is unknown,
   * already answered, or timed out. */
  result(commandId: string, body: Record<string, unknown>): boolean {
    const pending = this.pending.get(commandId)
    if (!pending) return false
    if (typeof body.applied !== 'boolean') throw new Error('invalid result')
    let layout: Record<string, unknown> | undefined
    if (body.applied && pending.kind === 'layout') {
      const value = body.layout
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid layout')
      layout = value as Record<string, unknown>
      if (
        layout.v !== 1 ||
        !Number.isSafeInteger(layout.pid) ||
        (layout.pid as number) <= 0 ||
        !(
          layout.startTime === null ||
          (typeof layout.startTime === 'string' && /^\d+$/.test(layout.startTime))
        ) ||
        typeof layout.updatedAt !== 'string' ||
        !Array.isArray(layout.displays) ||
        !Array.isArray(layout.windows)
      )
        throw new Error('invalid layout')
    } else if (body.layout !== undefined) throw new Error('unexpected layout')
    this.pending.delete(commandId)
    clearTimeout(pending.timer)
    if (body.applied)
      pending.resolve(layout ? { status: 'applied', layout } : { status: 'applied' })
    else {
      const error =
        typeof body.error === 'string' && ERROR_RE.test(body.error) ? body.error : 'gui_rejected'
      pending.resolve({ status: 'rejected', error })
    }
    return true
  }

  close(): void {
    const stream = this.stream
    this.stream = null
    if (stream) {
      this.failPending(stream)
      stream.end()
    }
  }

  /** A GUI that disconnects with a command in flight may have applied it. */
  private failPending(stream: ServerResponse): void {
    for (const [id, pending] of this.pending) {
      if (pending.stream !== stream) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.resolve({ status: 'timeout' })
    }
  }
}
