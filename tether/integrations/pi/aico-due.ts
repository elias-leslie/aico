/**
 * Pi's native puller for Tether's due lines (tether/docs/api-v1.md "Deliveries").
 *
 * Inside an Aico session (AICO_WIDGET_ID) it long-polls
 * `GET /v1/sessions/<id>/due?wait=55` on Tether's socket and hands each answer to Pi as a
 * follow-up user message. While it polls, Tether holds its own pane paste for the session and
 * hands lines out only when the agent is idle. Stops on session_shutdown, after a 404 (no such
 * session, or a Tether without the route) or for a shell (409 delivery_unsupported); anything
 * else (Tether down or restarting) is retried after 30 s. Fails quiet: never interrupts a turn.
 *
 * Installed as ~/.pi/agent/extensions/aico-due.ts, a symlink to the deployed release copy.
 */

import { request } from 'node:http'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const WAIT_SECONDS = 55
const BACKOFF_MS = 30_000
const SESSION_ID = /^[0-9a-f]{8}$/

type Answer = { status: number; body: Record<string, unknown> }

function socketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
  return process.env.TETHER_SOCKET || `${runtime}/tether/default/control.sock`
}

function poll(path: string, session: string, signal: AbortSignal): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: path,
        path: `/v1/sessions/${session}/due?wait=${WAIT_SECONDS}`,
        method: 'GET',
        headers: { Connection: 'close' },
        timeout: (WAIT_SECONDS + 15) * 1000,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          let body: Record<string, unknown> = {}
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            if (value && typeof value === 'object') body = value
          } catch {
            // Not JSON: treated like any other failed answer.
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('due poll overran')))
    req.on('error', reject)
    req.end()
  })
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export default function (pi: ExtensionAPI) {
  let current: AbortController | undefined

  const pull = async (session: string, signal: AbortSignal) => {
    const path = socketPath()
    while (!signal.aborted) {
      let answer: Answer
      try {
        answer = await poll(path, session, signal)
      } catch {
        if (signal.aborted) return
        answer = { status: 0, body: {} }
      }
      if (signal.aborted) return
      if (answer.status === 200) {
        const text = answer.body.text
        if (typeof text === 'string' && text) {
          try {
            pi.sendUserMessage(text, { deliverAs: 'followUp' })
          } catch {
            // Pi refused the message (shutting down): nothing more to do here.
          }
        }
        continue
      }
      const { status, body } = answer
      if (status === 404 || status === 400) return
      if (status === 409 && body.error === 'delivery_unsupported') return
      await pause(BACKOFF_MS, signal)
    }
  }

  const stop = () => {
    current?.abort()
    current = undefined
  }

  pi.on('session_start', () => {
    stop()
    const session = process.env.AICO_WIDGET_ID ?? ''
    if (!SESSION_ID.test(session)) return
    const controller = new AbortController()
    current = controller
    void pull(session, controller.signal)
  })

  pi.on('session_shutdown', stop)
}
