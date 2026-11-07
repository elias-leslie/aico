// Leaving with the machines off (`aico away`), from the Machines page and from the command line.
//
//   GET  /api/machines/away     {enabled, reason?}: whether shutting down is set up (`aico away --status`)
//   POST /api/machines/away     the page's button: runs `aico away --all` here. A refusal that comes
//                               at once (a plug that does not answer, a shutdown that cannot run)
//                               is the answer; otherwise it answers 202 and the shutdown goes on.
//   POST /api/machines/outage   {machines, guests?, clear?, settleSeconds?}: marks (or, with clear,
//                               unmarks) a planned outage in this Aico's Status, so the machines
//                               show off and nobody is paged. Only programs on this machine may
//                               ask (`aico away` calls it here and, over ssh, on the other Aico).
//                               `guests` adds every Proxmox guest this Aico lists.

import { execFile, spawn } from 'node:child_process'
import type { StatusStore } from '@aico/status'
import { fromThisMachine } from './guard'
import { objectBody, type Router } from './http'
import { HttpError } from './tether'

const MACHINE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_MACHINES = 64
/** How long the page waits for an early refusal before it answers "started". */
const EARLY_MS = 4_000

export interface AwayStatus {
  enabled: boolean
  reason?: string
}

/** Whether `aico away` may shut hosts down (its `away.enabled` setting); unreadable counts as not. */
const awayStatus = (): Promise<AwayStatus> =>
  new Promise((done) => {
    execFile('aico', ['away', '--status'], { timeout: 10_000 }, (error, stdout) => {
      try {
        const parsed = JSON.parse(stdout) as AwayStatus
        if (!error && typeof parsed.enabled === 'boolean') return done(parsed)
      } catch {}
      done({ enabled: false, reason: 'Couldn’t check whether shutting down is set up.' })
    })
  })

export type AwayStart = () => Promise<{ code: number; output: string } | null>

/** Runs `aico away --all` apart from this server (the shutdown ends the server too). Null: still going after EARLY_MS. */
const startAway: AwayStart = () =>
  new Promise((done) => {
    const child = spawn('aico', ['away', '--all'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const take = (chunk: Buffer) => {
      output += chunk.toString()
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = setTimeout(() => {
      child.unref()
      child.stdout.destroy()
      child.stderr.destroy()
      done(null)
    }, EARLY_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      done({ code: 127, output: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? 1, output })
    })
  })

/** The refusal in plain words: the last line the command printed, without its `aico away:` prefix. */
export function refusalOf(output: string): string {
  const last = output.trim().split('\n').pop() ?? ''
  return last.replace(/^aico away:\s*/, '') || 'The shutdown did not start.'
}

export interface AwayRoutes {
  status: Pick<StatusStore, 'planOutage' | 'clearOutage'>
  /** The machine names of the Proxmox guests this Aico lists. */
  guestMachines: () => Promise<string[]>
  start?: AwayStart
  setup?: () => Promise<AwayStatus>
  now?: () => number
}

export function registerAwayRoutes(router: Router, options: AwayRoutes): void {
  let going = false
  const state = () => (options.setup ?? awayStatus)()
  router.on('GET', '/api/machines/away', () => state())
  router.on('POST', '/api/machines/away', async () => {
    const ready = await state()
    if (!ready.enabled) throw new HttpError(409, ready.reason ?? 'Shutting down is not set up.')
    if (going) throw new HttpError(409, 'Already shutting down.')
    going = true
    try {
      const result = await (options.start ?? startAway)()
      if (result && result.code !== 0) throw new HttpError(502, refusalOf(result.output))
      return { started: result === null }
    } finally {
      going = false
    }
  })
  router.on('POST', '/api/machines/outage', async (ctx) => {
    if (!fromThisMachine(ctx.req))
      throw new HttpError(403, 'Planned outages are marked only by programs on this machine')
    const body = objectBody(await ctx.body())
    const given = body.machines
    if (!Array.isArray(given) || given.length === 0 || given.length > MAX_MACHINES)
      throw new HttpError(422, `machines must be 1 to ${MAX_MACHINES} names`)
    const machines = new Set<string>()
    for (const name of given) {
      if (typeof name !== 'string' || !MACHINE.test(name))
        throw new HttpError(422, 'machines must be machine names')
      machines.add(name)
    }
    const settle = body.settleSeconds
    if (settle !== undefined && !(typeof settle === 'number' && settle >= 0 && settle <= 3600))
      throw new HttpError(422, 'settleSeconds must be 0 to 3600')
    if (body.guests === true)
      for (const name of await options.guestMachines().catch(() => [])) machines.add(name)
    if (body.clear === true) {
      options.status.clearOutage([...machines])
      return { cleared: [...machines] }
    }
    const at = (options.now ?? Date.now)() + (typeof settle === 'number' ? settle : 0) * 1000
    options.status.planOutage([...machines], at)
    return { marked: [...machines], at: new Date(at).toISOString() }
  })
}
