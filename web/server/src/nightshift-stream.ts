// The Health panel's live feed: one connection from this server to Nightshift's
// item stream (its GET /api/stream, Server-Sent Events; docs/adr/0005 in
// Nightshift), shared by every browser that listens, relayed to them as
//
//   GET /api/nightshift/stream -> text/event-stream
//     event: live     data: {"live": true|false}   on connect and whenever the upstream comes or goes
//     event: changed  data: {}                     Nightshift's items or top line moved: read the view again
//
// The browser reads the view itself (GET /api/nightshift/view) on `changed`, so
// what it shows is always composed by readNightshiftView, never by this relay.
// The upstream opens while at least one browser listens and closes when none
// does; a dropped upstream reconnects with backoff and tells browsers
// `live: false` meanwhile, so they poll the view (which says when Nightshift
// isn't answering) rather than trust a feed that went quiet.

import type { ServerResponse } from 'node:http'
import { API_CSP } from './guard'
import { RAW, type Router, sendJson } from './http'
import type { NightshiftConfig } from './nightshift'

export type RelayEvent = { type: 'live'; live: boolean } | { type: 'changed' }
type Listener = (event: RelayEvent) => void

/** A bound on browser streams (a few owner devices; each tab holds one). */
export const MAX_NIGHTSHIFT_STREAMS = 32
/** Nightshift's own stream sends a comment every 15 s; browsers get one as often (the tunnel closes idle streams). */
const KEEPALIVE_MS = 15_000
/** Zero bytes (keepalives included) this long from Nightshift: the connection is dead, open a new one. */
const SILENCE_MS = 5 * 60_000
/** The upstream events that change what the panel shows. */
const UPSTREAM_EVENTS = new Set(['hello', 'item', 'health', 'reset'])

export interface RelayOptions {
  fetchImpl?: typeof fetch
  /** First reconnect delay, doubled per failure up to maxBackoffMs. */
  minBackoffMs?: number
  maxBackoffMs?: number
  /** A batch of upstream events (one rev can carry many items) becomes one `changed`. */
  coalesceMs?: number
  silenceMs?: number
}

export class NightshiftRelay {
  private readonly listeners = new Set<Listener>()
  private readonly fetchImpl: typeof fetch
  private readonly minBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly coalesceMs: number
  private readonly silenceMs: number
  private running: AbortController | null = null
  private changedTimer: ReturnType<typeof setTimeout> | null = null
  private lastError = ''
  live = false

  constructor(
    private readonly config: NightshiftConfig,
    options: RelayOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.minBackoffMs = options.minBackoffMs ?? 1_000
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000
    this.coalesceMs = options.coalesceMs ?? 250
    this.silenceMs = options.silenceMs ?? SILENCE_MS
  }

  get listening(): number {
    return this.listeners.size
  }

  /** Listen; the first listener opens the upstream, the last one leaving closes it. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    if (!this.running && this.config.nightshiftUrl) {
      const controller = new AbortController()
      this.running = controller
      void this.run(this.config.nightshiftUrl, controller.signal)
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      this.stop()
    }
  }

  stop(): void {
    this.running?.abort()
    this.running = null
    if (this.changedTimer) clearTimeout(this.changedTimer)
    this.changedTimer = null
    this.live = false
  }

  private emit(event: RelayEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private setLive(live: boolean): void {
    if (this.live === live) return
    this.live = live
    this.emit({ type: 'live', live })
  }

  private changed(): void {
    if (this.changedTimer) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      this.emit({ type: 'changed' })
    }, this.coalesceMs)
  }

  private async run(baseUrl: string, signal: AbortSignal): Promise<void> {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/stream`
    let delay = this.minBackoffMs
    while (!signal.aborted) {
      try {
        await this.follow(url, signal, () => {
          delay = this.minBackoffMs
        })
        if (!signal.aborted) throw new Error('stream ended')
      } catch (error) {
        if (signal.aborted) break
        const why = (error as Error).message || String(error)
        // Once per new reason, not every retry.
        if (why !== this.lastError)
          console.error(`[aico-web] Nightshift stream down (${why}); retrying with backoff`)
        this.lastError = why
      }
      if (signal.aborted) break
      this.setLive(false)
      await sleep(delay, signal)
      delay = Math.min(delay * 2, this.maxBackoffMs)
    }
  }

  /** One upstream connection, until it ends, fails, goes silent or `signal` aborts. */
  private async follow(url: string, signal: AbortSignal, opened: () => void): Promise<void> {
    const connection = new AbortController()
    const abort = () => connection.abort()
    signal.addEventListener('abort', abort, { once: true })
    let silence: ReturnType<typeof setTimeout> | undefined
    let silent = false
    const heard = () => {
      clearTimeout(silence)
      silence = setTimeout(() => {
        silent = true
        console.error(
          `[aico-web] Nightshift stream sent nothing for ${Math.round(this.silenceMs / 1000)} s: reconnecting`,
        )
        connection.abort()
      }, this.silenceMs)
    }
    try {
      heard()
      const response = await this.fetchImpl(url, {
        headers: { Accept: 'text/event-stream' },
        signal: connection.signal,
      })
      if (!response.ok || !response.body) throw new Error(`answered ${response.status}`)
      const decoder = new TextDecoder()
      let buffer = ''
      let event = ''
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        heard()
        buffer += decoder.decode(chunk, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (line === '') {
            // A frame ends: act on its event name (data is not needed, the view is re-read).
            if (UPSTREAM_EVENTS.has(event)) {
              if (!this.live) {
                opened()
                if (this.lastError) console.log('[aico-web] Nightshift stream back')
                this.lastError = ''
                this.setLive(true)
              }
              this.changed()
            }
            event = ''
          } else if (line.startsWith('event:')) {
            event = line.slice(6).trim()
          }
        }
      }
    } catch (error) {
      if (silent) throw new Error(`silent for ${Math.round(this.silenceMs / 1000)} s`)
      throw error
    } finally {
      clearTimeout(silence)
      signal.removeEventListener('abort', abort)
      connection.abort()
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

function frame(event: RelayEvent): string {
  const data = event.type === 'live' ? { live: event.live } : {}
  return `event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`
}

export function registerNightshiftStream(router: Router, relay: NightshiftRelay): void {
  let streams = 0
  router.on('GET', '/api/nightshift/stream', ({ res }) => {
    if (streams >= MAX_NIGHTSHIFT_STREAMS) {
      sendJson(res, 503, { detail: 'Too many health streams are open.' })
      return RAW
    }
    streams += 1
    serve(res, relay, () => {
      streams -= 1
    })
    return RAW
  })
}

function serve(res: ServerResponse, relay: NightshiftRelay, closed: () => void): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Content-Security-Policy': API_CSP,
    // Keep a buffering proxy from holding the events back.
    'X-Accel-Buffering': 'no',
  })
  const send = (text: string) => {
    if (!res.destroyed && !res.writableEnded) res.write(text)
  }
  send('retry: 5000\n\n')
  const unsubscribe = relay.subscribe((event) => send(frame(event)))
  // Where the upstream stands now; `live: true` follows when it opens.
  send(frame({ type: 'live', live: relay.live }))
  const keepalive = setInterval(() => send(': keepalive\n\n'), KEEPALIVE_MS)
  res.once('close', () => {
    clearInterval(keepalive)
    unsubscribe()
    closed()
  })
}
