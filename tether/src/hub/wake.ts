// The readiness gate (docs/plans/remote-hosts.md "Create"): a create for a host
// that is not up runs its hosts.json `wake`, then waits, bounded and with its
// progress on `GET /v1/hosts` and `peer.state`, for the link, the identity
// check and the host's health URLs (the forwarded Agent Hub and SummitFlow)
// before the create is sent. The link unit never wakes a host; a create does.

import { spawn } from 'node:child_process'
import { HttpError } from '../http'
import { SSH_BIN, SSH_MUX_ONLY } from './link'
import type { Peer } from './peer'

export type WakeStep = 'powering_on' | 'connecting' | 'checking_services'

/** What a create is waiting for on a host, shown while it waits and after it failed. */
export interface WakeProgress {
  state: 'starting' | 'failed'
  reason: 'host_starting'
  step: WakeStep
  since: number
  error: string | null
}

export interface GateRuntime {
  /** Run an argv to completion: its exit code (null when it could not run or
   * timed out) and the last line it printed. */
  run(argv: string[], timeoutMs: number): Promise<{ code: number | null; output: string }>
  /** Ask the host's link to retry now instead of waiting out its backoff. */
  kick(host: string): void
  sleep(ms: number): Promise<void>
  now(): number
  /** How long a host without `wake` gets for its link before a create gives up. */
  linkGraceMs: number
}

/** The wake command's own bound, inside the host's. */
const WAKE_RUN_MS = 120_000
const HEALTH_RUN_MS = 8_000
const POLL_MS = 500
const KICK_MS = 3_000
const HEALTH_RETRY_MS = 2_000
/** A host that was already up gets this long for its services to answer. */
const HEALTH_GRACE_MS = 15_000
const OUTPUT_BYTES = 4_096

function lastLine(text: string): string {
  const lines = text.trim().split('\n')
  return (lines[lines.length - 1] ?? '').trim().slice(0, 300)
}

export const defaultGateRuntime: GateRuntime = {
  run: (argv, timeoutMs) =>
    new Promise((resolve) => {
      const [command, ...args] = argv
      if (!command) {
        resolve({ code: null, output: 'empty command' })
        return
      }
      let output = ''
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-OUTPUT_BYTES)
      }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        output += `\ntimed out after ${Math.round(timeoutMs / 1000)} s`
      }, timeoutMs)
      child.once('error', (error) => {
        clearTimeout(timer)
        resolve({ code: null, output: error.message })
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code, output: lastLine(output) })
      })
    }),
  kick: (host) => {
    const [command = 'systemctl', ...args] = kickArgv(host)
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', () => {})
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  linkGraceMs: 10_000,
}

/** SIGUSR1 makes `tether link` retry at once (tether-link@.service). Only the
 * unit's main process: `systemctl kill` signals every process by default, and
 * ssh exits on SIGUSR1, which would drop a live link and every remote terminal
 * on it. A link that is up ignores the kick. */
export function kickArgv(host: string): string[] {
  return [
    'systemctl',
    '--user',
    'kill',
    '--kill-whom=main',
    '-s',
    'USR1',
    `tether-link@${host}.service`,
  ]
}

/** The argv that fetches one health URL on the host, through the link's ControlMaster. */
export function healthArgv(peer: Peer, url: string): string[] {
  return [
    SSH_BIN,
    ...SSH_MUX_ONLY,
    '-S',
    peer.control,
    peer.entry.ssh,
    '--',
    'curl',
    '-fsS',
    '-m',
    '3',
    '-o',
    '/dev/null',
    url,
  ]
}

/** Read through a call: the state changes while a create waits. */
function changedMachine(peer: Peer): boolean {
  return peer.state === 'identity_changed'
}

function refuse(peer: Peer, reason: string): HttpError {
  return new HttpError(409, 'host_unavailable', { host: peer.name, state: peer.state, reason })
}

/**
 * Bring `peer` to where a create can be sent: powered on, linked, the same
 * machine as before, and its health URLs answering. Resolves when it is;
 * rejects with `409 host_unavailable` and the real reason when it is not
 * within the host's `wakeTimeoutSec`.
 */
export async function readyHost(
  peer: Peer,
  runtime: GateRuntime,
  report: (progress: WakeProgress | null) => void,
): Promise<void> {
  const start = runtime.now()
  const deadline = start + peer.entry.wakeTimeoutSec * 1_000
  const seconds = peer.entry.wakeTimeoutSec
  const current: { progress: WakeProgress | null } = { progress: null }
  const step = (next: WakeStep) => {
    if (current.progress?.step === next) return
    current.progress = {
      state: 'starting',
      reason: 'host_starting',
      step: next,
      since: runtime.now(),
      error: null,
    }
    report(current.progress)
  }
  const fail = (reason: string): HttpError => {
    report({
      state: 'failed',
      reason: 'host_starting',
      step: current.progress?.step ?? 'connecting',
      since: runtime.now(),
      error: reason,
    })
    return refuse(peer, reason)
  }
  if (changedMachine(peer))
    throw refuse(peer, peer.error ?? `${peer.name} answers as a different machine`)

  const wasLive = peer.live
  let wakeNote: string | null = null
  if (!peer.live) {
    const wake = peer.entry.wake
    if (wake) {
      step('powering_on')
      const result = await runtime.run(wake, Math.min(WAKE_RUN_MS, deadline - runtime.now()))
      // A host that is already on fails its wake ("already running"); the link decides.
      if (result.code !== 0) wakeNote = result.output || `exit ${result.code ?? 'error'}`
    }
    step('connecting')
    const linkDeadline = wake ? deadline : Math.min(deadline, start + runtime.linkGraceMs)
    let kickedAt = 0
    while (!peer.live) {
      if (changedMachine(peer))
        throw fail(peer.error ?? `${peer.name} answers as a different machine`)
      if (runtime.now() >= linkDeadline) {
        const why = wake
          ? `${peer.name} did not come up within ${seconds} s`
          : `${peer.name} is not reachable and has no wake command`
        throw fail(wakeNote ? `${why} (wake: ${wakeNote})` : why)
      }
      if (runtime.now() - kickedAt >= KICK_MS) {
        runtime.kick(peer.name)
        peer.retryNow()
        kickedAt = runtime.now()
      }
      await runtime.sleep(POLL_MS)
    }
  }

  const urls = peer.entry.health
  if (urls.length) {
    step('checking_services')
    const healthDeadline = wasLive ? Math.min(deadline, runtime.now() + HEALTH_GRACE_MS) : deadline
    for (;;) {
      const results = await Promise.all(
        urls.map((url) => runtime.run(healthArgv(peer, url), HEALTH_RUN_MS)),
      )
      const failing = urls.findIndex((_, index) => results[index]?.code !== 0)
      if (failing < 0) break
      if (!peer.live) throw fail(`${peer.name} went away while its services were checked`)
      if (runtime.now() + HEALTH_RETRY_MS >= healthDeadline) {
        const detail = results[failing]?.output
        throw fail(
          `${peer.name} is up but ${urls[failing]} does not answer there${detail ? ` (${detail})` : ''}`,
        )
      }
      await runtime.sleep(HEALTH_RETRY_MS)
    }
  }
  if (current.progress) report(null)
}
