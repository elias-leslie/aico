// All lease writes reach one configured authority; no local fallback during a
// partition. Its own clock decides due/expiry and its durable fence rejects late results.
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { createServer as createCarrier, createConnection, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { JobDef } from './jobs'
import { nextRun, resumeAt } from './jobs'
import {
  type JobResult,
  type JobState,
  type JobStore,
  type Lease,
  type Routine,
  StaleLease,
} from './leases'
import type { LeaseAuthority } from './runner'

export interface LeaseCall {
  op:
    | 'claim'
    | 'renew'
    | 'complete'
    | 'release'
    | 'get'
    | 'run'
    | 'pause'
    | 'resume'
    | 'register'
    | 'unregister'
  kind: string
  who?: { holder: string; machine: string }
  lease?: Lease
  result?: JobResult
  ranAt?: number
  /** register: a routine another machine of its workers registered, to keep here too. */
  routine?: Routine
}

/** Local socket is private; remote callers reach it only over the pinned link.
 * Config supplies TTL, schedule and eligible machines; none are taken from callers. */
export function leaseCall(
  store: JobStore,
  jobs: readonly JobDef[],
  authority: string,
  call: LeaseCall,
  caller: string,
  now = Date.now(),
): unknown {
  // A routine registered on another of its machines is kept here too, so this machine's scheduler
  // knows it: only a machine in its own worker list may send it.
  if (call.op === 'register') {
    const routine = call.routine
    if (!routine || routine.kind !== call.kind || !(routine.workers ?? []).includes(caller))
      throw new Error('Routine is not for this caller')
    if (jobs.some((entry) => entry.kind === routine.kind && entry.source !== 'registered'))
      throw new Error(`There is already a built-in job '${routine.kind}' here`)
    store.addRoutine(routine)
    return null
  }
  if (call.op === 'unregister') {
    const known = store.routines().find((entry) => entry.kind === call.kind)
    if (known && !(known.workers ?? []).includes(caller))
      throw new Error('Routine is not for this caller')
    return store.removeRoutine(call.kind)
  }
  const job = jobs.find(
    (entry) => entry.kind === call.kind && (entry.lease_host ?? entry.home) === authority,
  )
  if (!job) throw new Error('Unknown job at this lease authority')
  const workers = job.workers ?? [job.home]
  if (call.op === 'get') return store.get(job.kind)
  if (call.op === 'run') return store.runNow(job.kind, now)
  if (call.op === 'pause') return store.setPaused(job.kind, true, now)
  if (call.op === 'resume') return store.setPaused(job.kind, false, resumeAt(job, now))
  if (call.op === 'claim') {
    const who = call.who
    if (who?.machine !== caller) throw new Error('Job caller does not match the pinned machine')
    if (!who || typeof who.holder !== 'string' || !who.holder || !workers.includes(who.machine))
      throw new Error('Machine is not a worker for this job')
    return store.claim(
      job.kind,
      who,
      now,
      job.lease_s * 1000,
      who.machine === job.home ? 0 : job.lease_s * 1000,
    )
  }
  const lease = call.lease
  if (lease?.machine !== caller) throw new Error('Job caller does not match the pinned machine')
  if (!lease || lease.kind !== job.kind || !workers.includes(lease.machine))
    throw new Error('Invalid job lease')
  const held = store.get(job.kind)
  if (!held || held.holder !== lease.holder || held.holderMachine !== lease.machine)
    throw new StaleLease(lease)
  if (call.op === 'renew') return store.renew(lease, now, job.lease_s * 1000)
  if (call.op === 'release') {
    store.release(lease, now + job.lease_s * 1000)
    return null
  }
  if (call.op !== 'complete') throw new Error('Unknown lease operation')
  const result = call.result
  if (
    !result ||
    !['ok', 'warn', 'failed'].includes(result.state) ||
    typeof result.meaning !== 'string' ||
    result.meaning.length > 300 ||
    !Number.isSafeInteger(call.ranAt)
  )
    throw new Error('Invalid job result')
  store.complete(lease, result, call.ranAt as number, nextRun(job, now))
  return null
}

export async function serveLeases(
  path: string,
  store: JobStore,
  jobs: readonly JobDef[] | (() => readonly JobDef[]),
  authority: string,
): Promise<Server & { closeAllConnections(): void }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error('Lease path is not a socket')
    // The service is the sole owner; a second runner must never unlink it.
    const live = await new Promise<boolean>((resolve) => {
      const socket = createConnection(path)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (live) throw new Error('Another lease server holds the socket')
    unlinkSync(path)
  }
  const callers = new WeakMap<Socket, string>()
  const http = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (text.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || req.url !== '/lease') throw new Error('Unknown lease route')
        const value = leaseCall(
          store,
          typeof jobs === 'function' ? jobs() : jobs,
          authority,
          JSON.parse(text) as LeaseCall,
          callers.get(req.socket) ?? '',
        )
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ value }))
      } catch (error) {
        res.statusCode = error instanceof StaleLease ? 409 : 400
        res.end(
          JSON.stringify({
            error: error instanceof StaleLease ? 'stale_lease' : (error as Error).message,
          }),
        )
      }
    })
  })
  // The fleet carrier prepends its authenticated pin name. HTTP headers/body
  // cannot replace it, including on keep-alive requests over the same channel.
  const sockets = new Set<Socket>()
  const server = Object.assign(
    createCarrier((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => sockets.delete(socket))
      let prefix = Buffer.alloc(0)
      const identify = (chunk: Buffer) => {
        prefix = Buffer.concat([prefix, chunk])
        const end = prefix.indexOf(10)
        if ((end < 0 && prefix.length > 63) || end > 63) {
          socket.destroy()
          return
        }
        if (end < 0) return
        const caller = prefix.subarray(0, end).toString()
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(caller)) {
          socket.destroy()
          return
        }
        socket.pause()
        socket.off('data', identify)
        callers.set(socket, caller)
        if (prefix.length > end + 1) socket.unshift(prefix.subarray(end + 1))
        http.emit('connection', socket)
        socket.resume()
      }
      socket.on('data', identify)
    }),
    {
      closeAllConnections: () => {
        for (const socket of sockets) socket.destroy()
      },
    },
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      chmodSync(path, 0o600)
      resolve()
    })
  })
  return server
}

async function remoteCall(socketPath: string, body: LeaseCall): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: 'POST',
        path: '/lease',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          try {
            const answer = JSON.parse(Buffer.concat(chunks).toString()) as {
              value?: unknown
              error?: string
            }
            if (res.statusCode === 409 && body.lease) {
              reject(new StaleLease(body.lease))
              return
            }
            if (res.statusCode !== 200)
              throw new Error(answer.error ?? `Lease authority answered ${res.statusCode}`)
            resolve(answer.value)
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

export function remoteAuthority(socket: string): LeaseAuthority & {
  run(kind: string): Promise<boolean>
  pause(kind: string): Promise<boolean>
  resume(kind: string): Promise<boolean>
  register(routine: Routine): Promise<void>
  unregister(kind: string): Promise<boolean>
} {
  return {
    claim: async (kind, who) =>
      (await remoteCall(socket, { op: 'claim', kind, who })) as Lease | null,
    renew: async (lease) =>
      (await remoteCall(socket, { op: 'renew', kind: lease.kind, lease })) as boolean,
    complete: async (lease, result, ranAt) => {
      await remoteCall(socket, { op: 'complete', kind: lease.kind, lease, result, ranAt })
    },
    release: async (lease) => {
      await remoteCall(socket, { op: 'release', kind: lease.kind, lease })
    },
    get: async (kind) => (await remoteCall(socket, { op: 'get', kind })) as JobState | null,
    run: async (kind) => (await remoteCall(socket, { op: 'run', kind })) as boolean,
    pause: async (kind) => (await remoteCall(socket, { op: 'pause', kind })) as boolean,
    resume: async (kind) => (await remoteCall(socket, { op: 'resume', kind })) as boolean,
    register: async (routine) => {
      await remoteCall(socket, { op: 'register', kind: routine.kind, routine })
    },
    unregister: async (kind) => (await remoteCall(socket, { op: 'unregister', kind })) as boolean,
  }
}
