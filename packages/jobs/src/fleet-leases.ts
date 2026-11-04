// All lease writes reach one configured authority; no local fallback during a
// partition. Its own clock decides due/expiry and its durable fence rejects late results.
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { dirname } from 'node:path'
import type { JobDef } from './jobs'
import { nextRun } from './jobs'
import { type JobResult, type JobState, type JobStore, type Lease, StaleLease } from './leases'
import type { LeaseAuthority } from './runner'

export interface LeaseCall {
  op: 'claim' | 'renew' | 'complete' | 'get' | 'run'
  kind: string
  who?: { holder: string; machine: string }
  lease?: Lease
  result?: JobResult
  ranAt?: number
}

/** Local socket is private; remote callers reach it only over the pinned link.
 * Config supplies TTL, schedule and eligible machines; none are taken from callers. */
export function leaseCall(
  store: JobStore,
  jobs: readonly JobDef[],
  authority: string,
  call: LeaseCall,
  now = Date.now(),
): unknown {
  const job = jobs.find(
    (entry) => entry.kind === call.kind && (entry.lease_host ?? entry.home) === authority,
  )
  if (!job) throw new Error('Unknown job at this lease authority')
  const workers = job.workers ?? [job.home]
  if (call.op === 'get') return store.get(job.kind)
  if (call.op === 'run') return store.runNow(job.kind, now)
  if (call.op === 'claim') {
    const who = call.who
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
  if (!lease || lease.kind !== job.kind || !workers.includes(lease.machine))
    throw new Error('Invalid job lease')
  const held = store.get(job.kind)
  if (!held || held.holder !== lease.holder || held.holderMachine !== lease.machine)
    throw new StaleLease(lease)
  if (call.op === 'renew') return store.renew(lease, now, job.lease_s * 1000)
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
  jobs: readonly JobDef[],
  authority: string,
): Promise<Server> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error('Lease path is not a socket')
    // The service is the sole owner; a second runner must never unlink it.
    const live = await remoteCall(path, { op: 'get', kind: jobs[0]?.kind ?? '' }).then(
      () => true,
      (error: Error) => !/ECONNREFUSED|ENOENT/.test(error.message),
    )
    if (live) throw new Error('Another lease server holds the socket')
    unlinkSync(path)
  }
  const server = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (text.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || req.url !== '/lease') throw new Error('Unknown lease route')
        const value = leaseCall(store, jobs, authority, JSON.parse(text) as LeaseCall)
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

export function remoteAuthority(
  socket: string,
): LeaseAuthority & { run(kind: string): Promise<boolean> } {
  return {
    claim: async (kind, who) =>
      (await remoteCall(socket, { op: 'claim', kind, who })) as Lease | null,
    renew: async (lease) =>
      (await remoteCall(socket, { op: 'renew', kind: lease.kind, lease })) as boolean,
    complete: async (lease, result, ranAt) => {
      await remoteCall(socket, { op: 'complete', kind: lease.kind, lease, result, ranAt })
    },
    get: async (kind) => (await remoteCall(socket, { op: 'get', kind })) as JobState | null,
    run: async (kind) => (await remoteCall(socket, { op: 'run', kind })) as boolean,
  }
}
