// The Hosts panel's routes (docs/api-v1.md "Remote hosts"): each host's
// sign-in state per agent tool, read through the fleet link; power on and off;
// tool login delivery from this machine's secrets folder or the tool's own login.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HttpError } from '@aico/shared/http'
import { execArgv, requestExec } from '../exec'
import { type HostEntry, hostsFilePath } from '../hosts'
import { linkPaths } from '../link'
import { type PeerAnswer, PeerUnavailable, peerRequest } from '../peer-http'
import { pushToolLogins, setToolGrant } from '../secrets'
import { readSettings } from '../settings'
import { downReason } from './peer'
import type { HubTools, ToolLogin } from './types'

/** A command's exit code (null when it could not run or timed out), its
 * stdout, and the last line it printed on stderr (else stdout) for a reason. */
export interface RunResult {
  code: number | null
  stdout: string
  output: string
}
export type Runner = (argv: string[], timeoutMs: number) => Promise<RunResult>

const STDOUT_BYTES = 256 * 1024

function lastLine(text: string): string {
  const lines = text.trim().split('\n')
  return (lines[lines.length - 1] ?? '').trim().slice(0, 300)
}

export const runCommand: Runner = (argv, timeoutMs) =>
  new Promise((resolve) => {
    const [command, ...args] = argv
    if (!command) {
      resolve({ code: null, stdout: '', output: 'empty command' })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < STDOUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_096)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, output: error.message })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const output = timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)} s`
        : lastLine(stderr) || lastLine(stdout)
      resolve({ code: timedOut ? null : code, stdout, output })
    })
  })

/** How one tool signs in and out on a host (adapters/contract.ts). `signIn` and a
 * `session` sign-out are shell lines typed into a new session there; `command` runs over ssh. */
export type { ToolLogin }

const STATUS_LINE = '"$HOME/.local/lib/tether/bin/tether" fleet login-status'
const STATUS_TIMEOUT_MS = 20_000
const COMMAND_TIMEOUT_MS = 30_000
const SLEEP_TIMEOUT_MS = 120_000
const CREATE_TIMEOUT_MS = 60_000
/** How often the hub looks at a sign-in session it opened, to end it once its
 * shell has exited. */
const SIGN_IN_FOLLOW_MS = 5_000
const TOOL = /^[a-z0-9][a-z0-9-]{0,39}$/

/** What host-admin needs from the hub. */
export interface HubView {
  hosts(): Record<string, unknown>[]
  hostEntry(name: string): HostEntry | null
  wakeHost(name: string): Promise<void>
  sessions(): Promise<Record<string, unknown>[]>
  /** The host was powered off on purpose: show it so once its link drops. */
  markPoweredOff(name: string): void
}

export interface HostAdminDeps {
  hub: HubView
  env: NodeJS.ProcessEnv
  run?: Runner
  peer?: (socket: string, method: string, path: string, body: unknown) => Promise<PeerAnswer>
  grant?: (name: string, tool: string, granted: boolean) => Promise<void>
  readFile?: (path: string) => string
  /** The tools' logins and sign-in title (the host's Tether passes its own). */
  tools: HubTools
  log?: (message: string) => void
  /** One-shot timer, injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown
}

export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** Run one shell line on the host through the link's ControlMaster, in a login
 * shell so the host's own PATH (codex, claude) applies. */
export function remoteArgv(_entry: HostEntry, control: string, line: string): string[] {
  return execArgv(control, ['bash', '-lc', line])
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The tools' own logins (`defaults`) with the override file's tools on top; a broken file is logged and ignored. */
export function loadLogins(
  env: NodeJS.ProcessEnv,
  read: (path: string) => string,
  log: (message: string) => void,
  defaults: Record<string, ToolLogin>,
): Record<string, ToolLogin> {
  const path = join(dirname(hostsFilePath(env)), 'host-logins.json')
  let text: string
  try {
    text = read(path)
  } catch {
    return defaults
  }
  try {
    const raw = record(JSON.parse(text))
    if (!raw) throw new Error('not an object')
    return { ...defaults, ...(raw as Record<string, ToolLogin>) }
  } catch (error) {
    log(`host-logins.json ignored: ${(error as Error).message}`)
    return defaults
  }
}

export class HostAdmin {
  private readonly run: Runner
  private readonly peer: NonNullable<HostAdminDeps['peer']>
  private readonly read: (path: string) => string
  private readonly tools: HubTools
  private readonly log: (message: string) => void

  constructor(private readonly deps: HostAdminDeps) {
    this.run = deps.run ?? runCommand
    this.peer =
      deps.peer ??
      ((socket, method, path, body) => peerRequest(socket, method, path, body, CREATE_TIMEOUT_MS))
    this.tools = deps.tools
    this.read = deps.readFile ?? ((path) => readFileSync(path, 'utf8'))
    this.log = deps.log ?? ((message) => console.log(`[tether:hosts] ${message}`))
  }

  private host(name: string): { entry: HostEntry; info: Record<string, unknown> } {
    const entry = this.deps.hub.hostEntry(name)
    const info = this.deps.hub.hosts().find((item) => item.name === name)
    if (!entry || !info) throw new HttpError(404, 'unknown_host', { host: name })
    return { entry, info }
  }

  /** The host as linked now; `409 host_unavailable` unless it is connected. */
  private live(name: string): { entry: HostEntry; control: string; socket: string } {
    const { entry, info } = this.host(name)
    if (info.state !== 'connected')
      throw new HttpError(409, 'host_unavailable', {
        host: name,
        state: info.state,
        reason: downReason(name, String(info.state)),
      })
    const control = String(info.control)
    return { entry, control, socket: linkPaths(dirname(control)).forwarded }
  }

  logins(): Record<string, ToolLogin> {
    return loadLogins(this.deps.env, this.read, this.log, this.tools.logins)
  }

  /** `GET /v1/hosts/:name/logins`: the host's `tether fleet login-status` as it
   * printed it, plus which tools Aico can sign in or out there. */
  async status(name: string): Promise<Record<string, unknown>> {
    const { entry, control } = this.live(name)
    const result = await this.run(remoteArgv(entry, control, STATUS_LINE), STATUS_TIMEOUT_MS)
    // A host without Tether's fleet command cannot say who is signed in. List the
    // tools anyway, Unknown and with their own sign-in, so the owner can sign in there.
    if (result.code === 127)
      return {
        host: name,
        tools: await this.localStatus(name, entry, control),
        checkedAt: Date.now(),
        actions: this.actions(),
      }
    if (result.code !== 0)
      throw new HttpError(502, 'login_status_failed', {
        host: name,
        reason: result.output || `exit ${result.code ?? 'error'}`,
      })
    const parsed = parseStatus(result.stdout)
    if (!parsed)
      throw new HttpError(502, 'login_status_failed', {
        host: name,
        reason: 'the host did not answer with JSON',
      })
    return { ...parsed, host: name, checkedAt: Date.now(), actions: this.actions() }
  }

  /** Without the fleet command: each tool's own login file on the host says whether it
   * is signed in (a file can hold an expired login; the tool says so when run). */
  private async localStatus(
    name: string,
    entry: HostEntry,
    control: string,
  ): Promise<Record<string, unknown>[]> {
    const logins = Object.entries(this.logins())
    const checks = logins
      .filter(([, login]) => login.local)
      .map(([tool, login]) => {
        const { bin, authFile } = login.local as { bin: string; authFile: string }
        return `printf '%s %s %s\\n' ${shellQuote(tool)} "$(command -v ${shellQuote(bin)} >/dev/null && echo y || echo n)" "$(test -s "$HOME"/${shellQuote(authFile)} && echo y || echo n)"`
      })
    const seen = new Map<string, { bin: boolean; file: boolean }>()
    if (checks.length) {
      const result = await this.run(
        remoteArgv(entry, control, checks.join('; ')),
        STATUS_TIMEOUT_MS,
      )
      if (result.code === 0)
        for (const line of result.stdout.split('\n')) {
          const [tool, bin, file] = line.trim().split(' ')
          if (tool) seen.set(tool, { bin: bin === 'y', file: file === 'y' })
        }
    }
    return logins.map(([tool, login]) => {
      const found = seen.get(tool)
      const authFile = login.local?.authFile
      if (!found || !authFile)
        return { tool, state: 'unknown', source: 'not checked', credentials: [] }
      if (!found.bin)
        return { tool, state: 'unknown', source: `not installed on ${name}`, credentials: [] }
      return {
        tool,
        state: found.file ? 'signed_in' : 'needs_sign_in',
        source: `host:~/${authFile}`,
        credentials: [],
      }
    })
  }

  /** What Aico can do per tool: sign in, and how to sign out. */
  private actions(): Record<string, { signIn: boolean; signOut: string | null }> {
    return Object.fromEntries(
      Object.entries(this.logins()).map(([tool, login]) => [
        tool,
        { signIn: !!login.signIn, signOut: login.signOut?.kind ?? null },
      ]),
    )
  }

  /** `POST /v1/hosts/:name/power`. On runs the create path's wake in the
   * background (progress on `GET /v1/hosts` and `peer.state`); off runs the
   * host's `sleep`, refused while sessions run there unless `force`. */
  async power(name: string, action: unknown, force: boolean): Promise<[number, unknown]> {
    const { entry, info } = this.host(name)
    if (action === 'on') {
      if (info.state === 'connected') return [200, { host: name, state: 'connected' }]
      if (!entry.wake)
        throw new HttpError(409, 'no_wake_command', {
          host: name,
          reason: `hosts.json has no wake command for ${name}`,
        })
      void this.deps.hub.wakeHost(name).catch((error: unknown) => {
        this.log(`${name}: power on failed: ${(error as Error).message}`)
      })
      return [202, { host: name, state: 'starting' }]
    }
    if (action !== 'off') throw new HttpError(400, 'invalid_body', { field: 'action' })
    if (!entry.sleep)
      throw new HttpError(409, 'no_sleep_command', {
        host: name,
        reason: `hosts.json has no sleep command for ${name}`,
      })
    const running = await this.runningSessions(name)
    const count = running.length
    if (count > 0 && !force)
      throw new HttpError(409, 'host_busy', {
        host: name,
        sessions: count,
        reason: `${count} session${count === 1 ? '' : 's'} running on ${name}`,
      })
    if (count > 0 && info.state === 'connected') await this.endSessions(name, running)
    const result = await this.run(entry.sleep, SLEEP_TIMEOUT_MS)
    if (result.code !== 0)
      throw new HttpError(502, 'power_failed', {
        host: name,
        reason: result.output || `exit ${result.code ?? 'error'}`,
      })
    this.deps.hub.markPoweredOff(name)
    this.log(`${name}: powered off${count ? ` after ending ${count} session(s)` : ''}`)
    return [200, { host: name, state: 'powering_off', sessions: count }]
  }

  private async runningSessions(name: string): Promise<Record<string, unknown>[]> {
    const items = await this.deps.hub.sessions()
    return items.filter((item) => item.host === name && item.status !== 'ended')
  }

  /** End the host's sessions before it powers off, as the warning says: the
   * host restores what was running when it boots (reboot continuity), so a
   * session left to the power-off would be listed again. One that will not
   * end keeps the host on. */
  private async endSessions(name: string, sessions: Record<string, unknown>[]): Promise<void> {
    const { socket } = this.live(name)
    const failed: string[] = []
    for (const item of sessions) {
      const id = String(item.id)
      const answer = await this.peer(socket, 'POST', `/v1/sessions/${encodeURIComponent(id)}/end`, {
        generation: item.generation,
      }).catch((error: Error) => ({ status: 0, body: { reason: error.message } }))
      // Already gone counts as ended.
      if (answer.status !== 200 && answer.status !== 404) {
        const why = record(answer.body)
        failed.push(`${id} (${String(why?.reason ?? why?.error ?? answer.status)})`)
      }
    }
    await this.deps.hub.sessions()
    if (failed.length)
      throw new HttpError(409, 'end_failed', {
        host: name,
        reason: `${name} was left on: ${failed.length === 1 ? 'a session' : `${failed.length} sessions`} there would not end (${failed.join(', ')})`,
      })
  }

  /** `POST /v1/hosts/:name/logins/:tool`: sign in or out. A 201 answer's
   * `session` is the shell opened on the host for the tool's own login. */
  async signInOut(
    name: string,
    tool: string,
    body: Record<string, unknown>,
  ): Promise<[number, unknown]> {
    if (!TOOL.test(tool)) throw new HttpError(400, 'invalid_body', { field: 'tool' })
    const login = this.logins()[tool]
    if (!login) throw new HttpError(404, 'unknown_tool', { tool })
    const action = body.action
    if (action === 'sign_in') {
      if (!login.signIn) throw new HttpError(409, 'sign_in_unsupported', { tool })
      this.host(name)
      await this.deps.hub.wakeHost(name)
      if (login.grant) {
        await this.grant(name, tool, true)
        return [200, { host: name, tool, signedIn: true }]
      }
      return this.openSession(name, `${this.tools.signInTitle}${tool}`, login.signIn, body)
    }
    if (action !== 'sign_out') throw new HttpError(400, 'invalid_body', { field: 'action' })
    const signOut = login.signOut
    if (!signOut) throw new HttpError(409, 'sign_out_unsupported', { tool })
    if (signOut.kind === 'session')
      return this.openSession(name, `Sign out: ${tool}`, signOut.line, body)
    if (signOut.kind === 'revoke') {
      this.host(name)
      await this.grant(name, tool, false)
      const info = this.host(name).info
      const note =
        info.state === 'connected'
          ? null
          : `${name} is not reachable; its login will be removed when it reconnects`
      return [200, { host: name, tool, signedOut: true, ...(note ? { note } : {}) }]
    }
    const { entry, control } = this.live(name)
    const result = await this.run(remoteArgv(entry, control, signOut.line), COMMAND_TIMEOUT_MS)
    if (result.code !== 0)
      throw new HttpError(502, 'sign_out_failed', {
        host: name,
        tool,
        reason: result.output || `exit ${result.code ?? 'error'}`,
      })
    return [200, { host: name, tool, signedOut: true }]
  }

  /** Per-machine tool grants live with fleet config; delivery uses the pinned link. */
  private async grant(name: string, tool: string, granted: boolean): Promise<void> {
    if (this.deps.grant) return this.deps.grant(name, tool, granted)
    try {
      const settings = readSettings(this.deps.env, '')
      if (!settings) throw new Error('Fleet is not configured')
      setToolGrant(settings, name, tool, granted, this.deps.env)
      if (granted) await pushToolLogins(settings, name, tool, this.deps.env)
      else if (this.host(name).info.state === 'connected') {
        const result = await requestExec(
          join(settings.peerRoot, name, 'exec.sock'),
          [
            'sh',
            '-c',
            'exec "$HOME/.local/lib/tether/bin/tether" fleet forget-login "$1"',
            'aico-login',
            tool,
          ],
          Buffer.alloc(0),
        )
        if (result.code !== 0) throw new Error('Peer refused login removal')
      }
    } catch {
      throw new HttpError(502, 'login_delivery_failed', {
        host: name,
        tool,
        reason: 'Could not deliver the tool login over the approved fleet link',
      })
    }
  }

  /** A shell session on the host with `line` typed in and run. The shell
   * exits once the line succeeds, so the host can idle off; a failure keeps it
   * open with the error on screen. */
  private async openSession(
    name: string,
    title: string,
    line: string,
    body: Record<string, unknown>,
  ): Promise<[number, unknown]> {
    const { socket } = this.live(name)
    const size = record(body.size) ?? { cols: 100, rows: 30 }
    const origin = typeof body.origin === 'string' ? body.origin : 'aico'
    let created: PeerAnswer
    try {
      created = await this.peer(socket, 'POST', '/v1/sessions', {
        tool: 'shell',
        name: title,
        origin,
        size,
      })
    } catch (error) {
      if (error instanceof PeerUnavailable)
        throw new HttpError(409, 'host_unavailable', { host: name, reason: error.message })
      throw error
    }
    const descriptor = record(created.body)
    if (created.status >= 300 || !descriptor || typeof descriptor.id !== 'string') {
      const answer = descriptor ?? {}
      throw new HttpError(created.status >= 400 ? created.status : 502, 'sign_in_failed', {
        host: name,
        reason: String(answer.reason ?? answer.error ?? 'the host did not open a session'),
      })
    }
    const id = descriptor.id
    const injected = await this.peer(socket, 'POST', `/v1/sessions/${id}/inject`, {
      generation: descriptor.generation,
      text: `${line} && exit`,
      mode: 'paste',
      submit: true,
    }).catch((error: Error) => ({ status: 0, body: { reason: error.message } }))
    // The hub learns the session's owner from a fresh list, so its routes find it.
    await this.deps.hub.sessions()
    const session: Record<string, unknown> = { ...descriptor, host: name }
    if (injected.status !== 200)
      session.failure = {
        code: 'inject_failed',
        reason: String(record(injected.body)?.reason ?? 'the command was not typed in'),
      }
    else this.follow(name, socket, id)
    return [201, { host: name, session }]
  }

  /** A shell that exits leaves its session `uncertain`, still listed and
   * keeping the host from idling off. Once the sign-in's shell has gone, end
   * the session through the host's Tether so every client sees it end. The
   * exit gives the session a new generation, so it is followed by id. Stops
   * when the session ended or the host went away. */
  private follow(name: string, socket: string, id: string): void {
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref())
    const path = `/v1/sessions/${encodeURIComponent(id)}`
    const look = async () => {
      const current = await this.peer(socket, 'GET', path, undefined)
      const row = record(current.body)
      if (current.status !== 200 || !row) return
      if (row.status === 'running' || row.status === 'pending') {
        setTimer(() => void look().catch(() => undefined), SIGN_IN_FOLLOW_MS)
        return
      }
      if (row.status !== 'uncertain') return
      const ended = await this.peer(socket, 'POST', `${path}/end`, { generation: row.generation })
      this.log(`sign-in session ${id} on ${name} exited; ended it (${ended.status})`)
      await this.deps.hub.sessions()
    }
    setTimer(() => void look().catch(() => undefined), SIGN_IN_FOLLOW_MS)
  }
}

/** `tether fleet login-status` output: the whole of it, or its last JSON object. */
export function parseStatus(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return record(JSON.parse(text.slice(start)))
  } catch {
    return null
  }
}
