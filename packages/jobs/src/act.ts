// What a job does: POST to the local aico-web, or run a command. Neither has a
// time limit: a job is never stopped for taking long.

import { spawn } from 'node:child_process'
import { request } from 'node:http'
import type { JobDef } from './jobs'
import type { JobResult } from './leases'

/** aico-web is not listening yet just after a boot; a refused connection is retried this often. */
const REFUSED_TRIES = 6
const REFUSED_WAIT_MS = 5_000

interface Answer {
  status: number
  body: string
}

function post(url: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end('{}')
  })
}

/** The answer's own sentence (`message` or `detail`), else the HTTP status. */
export function answerResult({ status, body }: Answer): JobResult {
  let said: string | null = null
  try {
    const parsed = JSON.parse(body) as { message?: unknown; detail?: unknown }
    said = typeof parsed.message === 'string' ? parsed.message : null
    said ??= typeof parsed.detail === 'string' ? parsed.detail : null
  } catch {}
  const ok = status >= 200 && status < 300
  return {
    state: ok ? 'ok' : 'failed',
    meaning: said ?? (ok ? 'Finished.' : `Aico answered ${status}.`),
  }
}

export async function postJob(
  webUrl: string,
  path: string,
  wait = REFUSED_WAIT_MS,
): Promise<JobResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return answerResult(await post(new URL(path, webUrl).toString()))
    } catch (error) {
      const refused = (error as { code?: string }).code === 'ECONNREFUSED'
      if (!refused || attempt >= REFUSED_TRIES)
        return { state: 'failed', meaning: `Could not reach Aico: ${(error as Error).message}` }
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

export function commandJob(argv: readonly string[]): Promise<JobResult> {
  return new Promise((resolve) => {
    const [file, ...args] = argv as [string, ...string[]]
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-2000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', (error) =>
      resolve({ state: 'failed', meaning: `Could not start: ${error.message}` }),
    )
    child.on('close', (code, signal) => {
      const last = tail.trim().split('\n').at(-1)?.trim() ?? ''
      if (code === 0) resolve({ state: 'ok', meaning: last || 'Finished.' })
      else
        resolve({
          state: 'failed',
          meaning: `${signal ? `Stopped by ${signal}` : `Exited ${code}`}${last ? `: ${last}` : '.'}`,
        })
    })
  })
}

export function act(webUrl: string): (job: JobDef) => Promise<JobResult> {
  return (job) => ('post' in job.run ? postJob(webUrl, job.run.post) : commandJob(job.run.command))
}
