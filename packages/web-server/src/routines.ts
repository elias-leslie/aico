// The Routines list's API. The scheduler owns routines (packages/jobs); this asks the installed
// `aico routines` so the page and the CLI always agree:
//
//   GET  /api/routines                  every routine (built in and registered): schedule, next run,
//                                       last result, paused, running (aico routines list --json)
//   POST /api/routines/run    {kind}    make it due now; its worker starts it within seconds
//   POST /api/routines/pause  {kind}    stop its scheduled runs
//   POST /api/routines/resume {kind}    schedule it again
//
// Registering and removing stay on the CLI (a project adds its own routine).

import { spawn } from 'node:child_process'
import { objectBody, type Router, requiredString } from './http'
import { HttpError } from './tether'

export type RoutinesCommand = (args: string[]) => Promise<string>

// A routine's kind; a systemd timer's is unit@host (e.g. host-steward-heartbeat@aico).
const KIND = /^[a-z0-9][a-z0-9.-]{0,95}(?:@[a-z0-9-]{1,63})?$/
const VERBS = ['run', 'pause', 'resume'] as const

const routinesCommand: RoutinesCommand = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('aico', ['routines', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (data) => {
      out = (out + String(data)).slice(-(4 << 20))
    })
    child.stderr.on('data', (data) => {
      err = (err + String(data)).slice(-2000)
    })
    child.on('error', () => reject(new HttpError(503, 'Routines could not start on this machine.')))
    child.on('close', (code) => {
      if (code !== 0)
        return reject(
          new HttpError(code === 2 ? 422 : 502, err.trim() || 'Routines did not answer.'),
        )
      resolve(out.trim())
    })
  })

/** A listing this young is answered from memory (the page polls; the CLI reads sockets of other machines). */
export const ROUTINES_FRESH_MS = 4_000

export function registerRoutineRoutes(
  router: Router,
  run: RoutinesCommand = routinesCommand,
  now: () => number = Date.now,
): void {
  let cached: { value: unknown; at: number } | null = null
  let reading: Promise<unknown> | null = null
  const read = () => {
    reading ??= run(['list', '--json'])
      .then((text) => {
        let value: unknown
        try {
          value = JSON.parse(text)
        } catch {
          throw new HttpError(502, 'Routines returned an unreadable list.')
        }
        cached = { value, at: now() }
        return value
      })
      .finally(() => {
        reading = null
      })
    return reading
  }
  router.on('GET', '/api/routines', async () => {
    const routines = cached && now() - cached.at <= ROUTINES_FRESH_MS ? cached.value : await read()
    return { routines }
  })
  for (const verb of VERBS)
    router.on('POST', `/api/routines/${verb}`, async (ctx) => {
      const kind = requiredString(objectBody(await ctx.body()), 'kind', { pattern: KIND })
      const message = await run([verb, kind])
      cached = null
      return { message }
    })
}
