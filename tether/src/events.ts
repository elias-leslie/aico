// In-process event bus behind `GET /v1/events` (NDJSON). Every event has a
// monotonically increasing `seq` within one daemon run (`bootId`). Clients
// resume with `?since=<seq>`; if the bounded replay buffer no longer holds the
// next event, the stream starts with a `gap` event and the client must re-list.

import { randomUUID } from 'node:crypto'

export type EventType =
  | 'hello'
  | 'gap'
  | 'heartbeat'
  | 'session.created'
  | 'session.updated'
  | 'session.ended'
  | 'session.resized'
  | 'root.updated'
  | 'tools.changed'
  | 'projects.changed'
  | 'legacy.changed'
  | 'gui.connected'
  | 'gui.disconnected'

export interface TetherEvent {
  seq: number
  bootId: string
  type: EventType
  at: number
  data: Record<string, unknown>
}

export type Listener = (event: TetherEvent) => void

export class EventBus {
  readonly bootId = randomUUID()
  private seq = 0
  private readonly buffer: TetherEvent[] = []
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly capacity = 1024,
    private readonly now: () => number = Date.now,
  ) {}

  get lastSeq(): number {
    return this.seq
  }

  publish(type: EventType, data: Record<string, unknown> = {}): TetherEvent {
    this.seq += 1
    const event: TetherEvent = { seq: this.seq, bootId: this.bootId, type, at: this.now(), data }
    this.buffer.push(event)
    if (this.buffer.length > this.capacity) this.buffer.shift()
    for (const listener of this.listeners) listener(event)
    return event
  }

  /** Events after `since`, or null when some were already evicted. */
  replay(since: number): TetherEvent[] | null {
    if (since >= this.seq) return []
    const oldest = this.buffer[0]?.seq ?? this.seq + 1
    if (since + 1 < oldest) return null
    return this.buffer.filter((event) => event.seq > since)
  }

  /** Non-persisted control events (hello, gap, heartbeat) carry the current seq. */
  control(type: 'hello' | 'gap' | 'heartbeat', data: Record<string, unknown> = {}): TetherEvent {
    return { seq: this.seq, bootId: this.bootId, type, at: this.now(), data }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get subscriberCount(): number {
    return this.listeners.size
  }
}
