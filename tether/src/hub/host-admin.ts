// The Hosts panel's routes (docs/api-v1.md "Remote hosts"): each host's
// sign-in state per agent tool, read on the host with `agent-hub login status`
// through the link's ssh ControlMaster; power on (the create path's wake) and
// off (hosts.json `sleep`); and sign in or out, which opens a short shell
// session on the host running the tool's own login, or revokes the host's
// grant in Agent Hub. No credential value passes through here.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLIENT_ID_HEADER, OWNER_TOKEN_HEADER, REQUEST_SOURCE_HEADER } from '@agent-hub/sdk'
import type { AgentHubConfig } from '../agent-hub/config'
import { HttpError, type Router, readJsonObject, sendJson } from '../http'
import { type HostEntry, hostsFilePath } from './hosts'
import { linkPaths, SSH_BIN } from './link'
import { type PeerAnswer, PeerUnavailable, peerRequest } from './peer-http'

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

/** How one tool signs in and out on a host. `signIn` and a `session` sign-out
 * are shell lines typed into a new session there; `command` runs over ssh. */
export interface ToolLogin {
  signIn: string | null
  signOut:
    | { kind: 'revoke' }
    | { kind: 'command'; line: string }
    | { kind: 'session'; line: string }
    | null
  /** A served tool: sign-in grants it to the host first (push needs the grant). */
  grant?: boolean
}

/** The tools' own logins (agent-hub docs/remote-host-credentials.md). A
 * `host-logins.json` next to hosts.json overrides them per tool. */
export const DEFAULT_LOGINS: Record<string, ToolLogin> = {
  'claude-code': {
    signIn:
      'agent-hub native claude setup-token && agent-hub credential push claude-code && agent-hub install',
    signOut: { kind: 'revoke' },
    grant: true,
  },
  codex: {
    signIn: 'codex login --device-auth',
    signOut: { kind: 'command', line: 'codex logout' },
  },
  pi: {
    signIn: "echo 'In pi, type /login and pick a provider.'; pi",
    signOut: { kind: 'session', line: "echo 'In pi, type /logout.'; pi" },
  },
  agy: {
    signIn: "echo 'agy asks you to sign in when it starts.'; agy",
    signOut: { kind: 'session', line: "echo 'In agy, type /logout.'; agy" },
  },
}

export const STATUS_LINE = 'agent-hub login status --json'
/** The host's own refresh of its shims after a grant changed. */
export const INSTALL_LINE = 'agent-hub install'
const STATUS_TIMEOUT_MS = 20_000
const COMMAND_TIMEOUT_MS = 30_000
const SLEEP_TIMEOUT_MS = 120_000
const CREATE_TIMEOUT_MS = 60_000
const AGENT_HUB_TIMEOUT_MS = 10_000
const TOOL = /^[a-z0-9][a-z0-9-]{0,39}$/

/** What host-admin needs from the hub. */
export interface HubView {
  hosts(): Record<string, unknown>[]
  hostEntry(name: string): HostEntry | null
  wakeHost(name: string): Promise<void>
  sessions(): Promise<Record<string, unknown>[]>
}

export interface HostAdminDeps {
  hub: HubView
  agentHub: AgentHubConfig
  env: NodeJS.ProcessEnv
  run?: Runner
  peer?: (socket: string, method: string, path: string, body: unknown) => Promise<PeerAnswer>
  fetch?: typeof fetch
  readFile?: (path: string) => string
  log?: (message: string) => void
}

function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** Run one shell line on the host through the link's ControlMaster, in a login
 * shell so the host's own PATH (agent-hub, codex) applies. */
export function remoteArgv(entry: HostEntry, control: string, line: string): string[] {
  return [
    SSH_BIN,
    '-F',
    '/dev/null',
    '-T',
    '-o',
    'BatchMode=yes',
    '-S',
    control,
    entry.ssh,
    '--',
    `bash -lc ${shellQuote(line)}`,
  ]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** `DEFAULT_LOGINS` with the override file's tools on top; a broken file is logged and ignored. */
export function loadLogins(
  env: NodeJS.ProcessEnv,
  read: (path: string) => string,
  log: (message: string) => void,
): Record<string, ToolLogin> {
  const path = join(dirname(hostsFilePath(env)), 'host-logins.json')
  let text: string
  try {
    text = read(path)
  } catch {
    return DEFAULT_LOGINS
  }
  try {
    const raw = record(JSON.parse(text))
    if (!raw) throw new Error('not an object')
    return { ...DEFAULT_LOGINS, ...(raw as Record<string, ToolLogin>) }
  } catch (error) {
    log(`host-logins.json ignored: ${(error as Error).message}`)
    return DEFAULT_LOGINS
  }
}

export class HostAdmin {
  private readonly run: Runner
  private readonly peer: NonNullable<HostAdminDeps['peer']>
  private readonly fetch: typeof fetch
  private readonly read: (path: string) => string
  private readonly log: (message: string) => void

  constructor(private readonly deps: HostAdminDeps) {
    this.run = deps.run ?? runCommand
    this.peer =
      deps.peer ??
      ((socket, method, path, body) => peerRequest(socket, method, path, body, CREATE_TIMEOUT_MS))
    this.fetch = deps.fetch ?? fetch
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
        reason: `${name} is ${info.state === 'connecting' ? 'still connecting' : 'not reachable'}`,
      })
    const control = String(info.control)
    return { entry, control, socket: linkPaths(dirname(control)).forwarded }
  }

  logins(): Record<string, ToolLogin> {
    return loadLogins(this.deps.env, this.read, this.log)
  }

  /** `GET /v1/hosts/:name/logins`: the host's `login status --json` as it
   * printed it, plus which tools Aico can sign in or out there. */
  async status(name: string): Promise<Record<string, unknown>> {
    const { entry, control } = this.live(name)
    const result = await this.run(remoteArgv(entry, control, STATUS_LINE), STATUS_TIMEOUT_MS)
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
    const logins = this.logins()
    const actions = Object.fromEntries(
      Object.entries(logins).map(([tool, login]) => [
        tool,
        { signIn: !!login.signIn, signOut: login.signOut?.kind ?? null },
      ]),
    )
    return { ...parsed, host: name, checkedAt: Date.now(), actions }
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
    if (running > 0 && !force)
      throw new HttpError(409, 'host_busy', {
        host: name,
        sessions: running,
        reason: `${running} session${running === 1 ? '' : 's'} running on ${name}`,
      })
    const result = await this.run(entry.sleep, SLEEP_TIMEOUT_MS)
    if (result.code !== 0)
      throw new HttpError(502, 'power_failed', {
        host: name,
        reason: result.output || `exit ${result.code ?? 'error'}`,
      })
    this.log(`${name}: powered off${running ? ` with ${running} session(s) running` : ''}`)
    return [200, { host: name, state: 'powering_off', sessions: running }]
  }

  private async runningSessions(name: string): Promise<number> {
    const items = await this.deps.hub.sessions()
    return items.filter((item) => item.host === name && item.status !== 'ended').length
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
      if (login.grant) await this.grant(name, tool, true)
      return this.openSession(name, `Sign in: ${tool}`, login.signIn, body)
    }
    if (action !== 'sign_out') throw new HttpError(400, 'invalid_body', { field: 'action' })
    const signOut = login.signOut
    if (!signOut) throw new HttpError(409, 'sign_out_unsupported', { tool })
    if (signOut.kind === 'session')
      return this.openSession(name, `Sign out: ${tool}`, signOut.line, body)
    if (signOut.kind === 'revoke') {
      this.host(name)
      await this.grant(name, tool, false)
      // The shim would now refuse to start the tool; drop it if the host is up.
      const note = await this.refreshShims(name)
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

  private async refreshShims(name: string): Promise<string | null> {
    let target: ReturnType<HostAdmin['live']>
    try {
      target = this.live(name)
    } catch {
      return `${name} is not reachable; its shims update on the next agent-hub install`
    }
    const result = await this.run(
      remoteArgv(target.entry, target.control, INSTALL_LINE),
      COMMAND_TIMEOUT_MS,
    )
    return result.code === 0 ? null : `agent-hub install failed on ${name}: ${result.output}`
  }

  /** Grant or deny `tool` to the host in Agent Hub (owner API). */
  private async grant(name: string, tool: string, granted: boolean): Promise<void> {
    const config = this.deps.agentHub
    const headers: Record<string, string> = { [REQUEST_SOURCE_HEADER]: config.requestSource }
    if (config.clientId) headers[CLIENT_ID_HEADER] = config.clientId
    if (config.ownerTokenFile) {
      try {
        const token = this.read(config.ownerTokenFile).trim()
        if (token) headers[OWNER_TOKEN_HEADER] = token
      } catch {
        // Agent Hub answers 401/403 below and says so.
      }
    }
    const url = `${config.baseUrl.replace(/\/$/, '')}/api/remote-hosts/${encodeURIComponent(name)}/tools/${encodeURIComponent(tool)}`
    let response: Response
    try {
      response = await this.fetch(url, {
        method: granted ? 'PUT' : 'DELETE',
        headers,
        signal: AbortSignal.timeout(AGENT_HUB_TIMEOUT_MS),
      })
    } catch (error) {
      throw new HttpError(503, 'agent_hub_unavailable', { reason: (error as Error).message })
    }
    if (!response.ok) {
      let reason = `Agent Hub answered ${response.status}`
      try {
        const detail = record(await response.json())?.detail
        if (typeof detail === 'string') reason = detail
      } catch {}
      throw new HttpError(502, 'agent_hub_refused', { host: name, tool, reason })
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
    return [201, { host: name, session }]
  }
}

/** `login status --json` output: the whole of it, or its last JSON object. */
export function parseStatus(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return record(JSON.parse(text.slice(start)))
  } catch {
    return null
  }
}

export function registerHostAdminRoutes(router: Router, admin: () => HostAdmin): void {
  router
    .add('GET', '/v1/hosts/:name/logins', async (_req, res, params) => {
      sendJson(res, 200, await admin().status(params.name ?? ''))
    })
    .add('POST', '/v1/hosts/:name/power', async (req, res, params) => {
      const body = await readJsonObject(req)
      if (body.force !== undefined && typeof body.force !== 'boolean')
        throw new HttpError(400, 'invalid_body', { field: 'force' })
      const [status, answer] = await admin().power(params.name ?? '', body.action, !!body.force)
      sendJson(res, status, answer)
    })
    .add('POST', '/v1/hosts/:name/logins/:tool', async (req, res, params) => {
      const body = await readJsonObject(req)
      const [status, answer] = await admin().signInOut(params.name ?? '', params.tool ?? '', body)
      sendJson(res, status, answer)
    })
}
