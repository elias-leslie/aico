// The readiness gate (docs/plans/remote-hosts.md "Create"): a create for a host
// that is not up runs its hosts.json `wake`, then waits, bounded and with its
// progress on `GET /v1/hosts` and `peer.state`, for the link, the identity
// check and the host's health URLs (the forwarded services)
// before the create is sent. The link unit never wakes a host; a create does.

import { spawn } from 'node:child_process'
import { execArgv } from '@aico/fleet/exec'
import { HttpError } from '@aico/shared/http'
import type { Peer } from './peer'
import type { WakeProgress, WakeStep } from './types'

export type { WakeProgress } from './types'

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
  kick: () => {},
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  linkGraceMs: 10_000,
}

/** The argv that fetches one health URL on the host, through the link's ControlMaster. */
function healthArgv(peer: Peer, url: string): string[] {
  return execArgv(peer.control, ['curl', '-fsS', '-m', '3', '-o', '/dev/null', url])
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
 * machine as before, its health URLs answering, and no update of its Tether
 * running (`updating`, src/hub/update.ts: the update restarts it). Resolves
 * when it is; rejects with `409 host_unavailable` and the real reason when it
 * is not within the host's `wakeTimeoutSec`, which bounds the update wait too.
 */
export async function readyHost(
  peer: Peer,
  runtime: GateRuntime,
  report: (progress: WakeProgress | null) => void,
  updating: () => Promise<void> | null = () => null,
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

  // A host whose link still looked up can be gone already (`st vm rollback`
  // powered it off before the link noticed). Once it is seen gone, it is
  // brought up like any down host, once per create.
  let broughtUp = false
  for (;;) {
    await updated()
    const wasLive = peer.live
    if (!peer.live) {
      broughtUp = true
      await bringUp()
      // Its link-up can start an update of its Tether: that goes first.
      if (updating()) continue
    }
    if (await servicesAnswer(wasLive)) {
      if (updating()) continue
      break
    }
  }
  if (current.progress) report(null)

  /** Wait out an update of the host's Tether, within the deadline. */
  async function updated(): Promise<void> {
    const running = updating()
    if (!running) return
    let done = false
    const settle = () => {
      done = true
    }
    running.then(settle, settle)
    while (!done) {
      if (runtime.now() >= deadline) {
        const update = peer.update
        const detail = update ? ` from API ${update.from} to ${update.to}` : ''
        throw fail(`${peer.name}'s Tether is still being updated${detail}`)
      }
      await runtime.sleep(POLL_MS)
    }
  }

  async function bringUp(): Promise<void> {
    let wakeNote: string | null = null
    const wake = peer.entry.wake
    if (wake) {
      step('powering_on')
      const result = await runtime.run(wake, Math.min(WAKE_RUN_MS, deadline - runtime.now()))
      // A host that is already on fails its wake ("already running"); the link decides.
      if (result.code !== 0) wakeNote = result.output || `exit ${result.code ?? 'error'}`
    }
    step('connecting')
    const linkStart = runtime.now()
    const linkDeadline = wake ? deadline : Math.min(deadline, linkStart + runtime.linkGraceMs)
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

  /** True once every health URL answers; false when the host went away and
   * should be brought up first. */
  async function servicesAnswer(wasLive: boolean): Promise<boolean> {
    const urls = peer.entry.health
    if (!urls.length) return true
    step('checking_services')
    const healthDeadline = wasLive ? Math.min(deadline, runtime.now() + HEALTH_GRACE_MS) : deadline
    for (;;) {
      const results = await Promise.all(
        urls.map((url) => runtime.run(healthArgv(peer, url), HEALTH_RUN_MS)),
      )
      const failing = urls.findIndex((_, index) => results[index]?.code !== 0)
      if (failing < 0) return true
      if (!peer.live) {
        // An update's restart, not the host going away: wait for it, then look again.
        if (!broughtUp || updating()) return false
        throw fail(`${peer.name} went away while its services were checked`)
      }
      if (runtime.now() + HEALTH_RETRY_MS >= healthDeadline) {
        const detail = results[failing]?.output
        throw fail(
          `${peer.name} is up but ${urls[failing]} does not answer there${detail ? ` (${detail})` : ''}`,
        )
      }
      await runtime.sleep(HEALTH_RETRY_MS)
    }
  }
}
