import { execArgv } from '../exec'

const FLEET_BIN = execArgv('', [])[0] as string

import { HttpError } from '@aico/shared/http'
import { describe, expect, it, vi } from 'vitest'
import type { HostEntry } from '../hosts'
import type { PeerAnswer } from '../peer-http'
import {
  HostAdmin,
  type HostAdminDeps,
  loadLogins,
  parseStatus,
  type RunResult,
  remoteArgv,
} from './host-admin'
import { TEST_LOGINS, TEST_PORTS } from './testing'

const ENTRY: HostEntry = {
  name: 'vm-1',
  ssh: 'vm-1',
  socket: '/run/user/1000/tether/default/control.sock',
  sync: null,
  wake: ['st', 'vm', 'start', '200'],
  sleep: ['st', 'vm', 'shutdown', '200'],
  status: null,
  statusOff: '\\bstopped\\b',
  health: [],
  wakeTimeoutSec: 240,
  idleOffMin: 15,
  stateDir: null,
}
const CONTROL = '/run/user/1000/aico/fleet/vm-1/exec.sock'

const STATUS = {
  host: 'vm-1',
  tools: [{ tool: 'codex', state: 'needs_sign_in', source: 'host:/home/u/.codex/auth.json' }],
}

function setup(
  options: {
    state?: string
    sessions?: Record<string, unknown>[]
    run?: (argv: string[]) => RunResult
    peer?: (method: string, path: string, body: unknown) => PeerAnswer
    grant?: (name: string, tool: string, granted: boolean) => Promise<void>
  } = {},
) {
  const runs: string[][] = []
  const peerCalls: { method: string; path: string; body: unknown }[] = []
  const fetches: { url: string; method: string; headers: Record<string, string> }[] = []
  const wakeHost = vi.fn(async () => {})
  const sessions = vi.fn(async () => options.sessions ?? [])
  const markPoweredOff = vi.fn()
  const timers: (() => void)[] = []
  const deps: HostAdminDeps = {
    setTimer: (fn) => timers.push(fn),
    hub: {
      hosts: () => [{ name: 'vm-1', state: options.state ?? 'connected', control: CONTROL }],
      hostEntry: (name) => (name === 'vm-1' ? ENTRY : null),
      wakeHost,
      sessions,
      markPoweredOff,
    },
    env: { HOME: '/home/u', XDG_CONFIG_HOME: '/cfg' },
    tools: TEST_PORTS.tools,
    run: async (argv) => {
      runs.push(argv)
      return options.run?.(argv) ?? { code: 0, stdout: JSON.stringify(STATUS), output: '' }
    },
    peer: async (_socket, method, path, body) => {
      peerCalls.push({ method, path, body })
      return (
        options.peer?.(method, path, body) ??
        (path === '/v1/sessions'
          ? { status: 201, body: { id: 'abcd1234', generation: 'g1', status: 'running' } }
          : { status: 200, body: { delivered: true } })
      )
    },
    grant: async (name, tool, granted) => {
      fetches.push({ url: `${name}/${tool}`, method: granted ? 'PUT' : 'DELETE', headers: {} })
      await options.grant?.(name, tool, granted)
    },
    readFile: (path) => {
      if (path === '/tokens/owner') return 'owner-secret\n'
      throw new Error('ENOENT')
    },
    log: () => {},
  }
  return {
    timers,
    admin: new HostAdmin(deps),
    runs,
    peerCalls,
    fetches,
    wakeHost,
    sessions,
    markPoweredOff,
  }
}

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('login status', () => {
  it('runs the fleet login status on the host through the link and returns its answer', async () => {
    const { admin, runs } = setup()
    const answer = await admin.status('vm-1')
    expect(runs[0]).toEqual(
      remoteArgv(ENTRY, CONTROL, '"$HOME/.local/lib/tether/bin/tether" fleet login-status'),
    )
    expect(runs[0]?.slice(0, 5)).toEqual([FLEET_BIN, 'fleet', 'exec', CONTROL, '--'])
    expect(answer).toMatchObject({ ...STATUS, host: 'vm-1' })
    expect(answer.actions).toMatchObject({
      'claude-code': { signIn: true, signOut: 'revoke' },
      codex: { signIn: true, signOut: 'command' },
      pi: { signIn: true, signOut: 'session' },
    })
  })

  it('lists the tools as unknown, with their sign-in, on a host with no fleet command', async () => {
    const { admin } = setup({
      run: () => ({ code: 127, stdout: '', output: 'bash: line 1: tether: command not found' }),
    })
    const answer = await admin.status('vm-1')
    expect(answer).toMatchObject({ host: 'vm-1' })
    const tools = answer.tools as { tool: string; state: string }[]
    expect(tools.map((item) => item.tool)).toEqual(
      expect.arrayContaining(['claude-code', 'codex', 'pi', 'agy']),
    )
    expect(tools.every((item) => item.state === 'unknown')).toBe(true)
    expect(answer.actions).toMatchObject({ agy: { signIn: true, signOut: 'session' } })
  })

  it("checks each tool's own login file on a host with no fleet command", async () => {
    const { admin, runs } = setup({
      run: (argv) =>
        argv.at(-1)?.includes('fleet login-status')
          ? { code: 127, stdout: '', output: 'bash: line 1: tether: command not found' }
          : { code: 0, stdout: 'claude-code n n\ncodex y n\npi n n\nagy y y\n', output: '' },
    })
    const answer = await admin.status('vm-1')
    const tools = Object.fromEntries(
      (answer.tools as { tool: string; state: string; source: string }[]).map((item) => [
        item.tool,
        item,
      ]),
    )
    expect(tools.agy).toMatchObject({
      state: 'signed_in',
      source: 'host:~/.gemini/antigravity-cli/antigravity-oauth-token',
    })
    expect(tools.codex).toMatchObject({ state: 'needs_sign_in', source: 'host:~/.codex/auth.json' })
    expect(tools.pi).toMatchObject({ state: 'unknown', source: 'not installed on vm-1' })
    expect(runs).toHaveLength(2)
    expect(runs[1]?.at(-1)).toContain('"$HOME"/')
  })

  it('refuses while the host is not connected, without running anything', async () => {
    const { admin, runs } = setup({ state: 'offline' })
    const error = await refusal(admin.status('vm-1'))
    expect(error.status).toBe(409)
    expect(error.code).toBe('host_unavailable')
    expect(runs).toEqual([])
  })

  it('says why when the host command fails or prints no JSON', async () => {
    const failing = setup({
      run: () => ({ code: 1, stdout: '', output: 'boom' }),
    })
    const error = await refusal(failing.admin.status('vm-1'))
    expect(error.status).toBe(502)
    expect(error.extra).toMatchObject({ reason: 'boom' })
    const garbled = setup({ run: () => ({ code: 0, stdout: 'hello', output: 'hello' }) })
    expect((await refusal(garbled.admin.status('vm-1'))).code).toBe('login_status_failed')
  })

  it('404s an unknown host', async () => {
    const { admin } = setup()
    expect((await refusal(admin.status('nope'))).status).toBe(404)
  })
})

describe('power', () => {
  it('powers on in the background through the hub wake', async () => {
    const { admin, wakeHost } = setup({ state: 'offline' })
    expect(await admin.power('vm-1', 'on', false)).toEqual([
      202,
      { host: 'vm-1', state: 'starting' },
    ])
    expect(wakeHost).toHaveBeenCalledWith('vm-1')
  })

  it('refuses power off while sessions run there, unless forced', async () => {
    const sessions = [
      { id: 'a', host: 'vm-1', status: 'running', generation: 'ga' },
      { id: 'b', host: 'vm-1', status: 'ended' },
      { id: 'c', host: null, status: 'running' },
    ]
    const { admin, runs, peerCalls, markPoweredOff } = setup({ sessions })
    const error = await refusal(admin.power('vm-1', 'off', false))
    expect(error.status).toBe(409)
    expect(error.code).toBe('host_busy')
    expect(error.extra).toMatchObject({ sessions: 1, reason: '1 session running on vm-1' })
    expect(runs).toEqual([])
    expect(peerCalls).toEqual([])
    const [status, answer] = await admin.power('vm-1', 'off', true)
    expect(status).toBe(200)
    expect(answer).toMatchObject({ state: 'powering_off', sessions: 1 })
    // The session is ended first, so the host does not restore it on boot.
    expect(peerCalls).toEqual([
      { method: 'POST', path: '/v1/sessions/a/end', body: { generation: 'ga' } },
    ])
    expect(runs).toEqual([['st', 'vm', 'shutdown', '200']])
    expect(markPoweredOff).toHaveBeenCalledWith('vm-1')
  })

  it('leaves the host on when a session there will not end', async () => {
    const sessions = [
      { id: 'a', host: 'vm-1', status: 'running', generation: 'ga' },
      { id: 'd', host: 'vm-1', status: 'uncertain', generation: 'gd' },
    ]
    const { admin, runs, markPoweredOff } = setup({
      sessions,
      peer: (_method, path) =>
        path === '/v1/sessions/a/end'
          ? { status: 409, body: { error: 'busy' } }
          : { status: 404, body: { error: 'not_found' } },
    })
    const error = await refusal(admin.power('vm-1', 'off', true))
    expect(error.code).toBe('end_failed')
    expect(error.extra).toMatchObject({
      reason: 'vm-1 was left on: a session there would not end (a (busy))',
    })
    expect(runs).toEqual([])
    expect(markPoweredOff).not.toHaveBeenCalled()
  })

  it('reports a failed sleep command', async () => {
    const { admin } = setup({ run: () => ({ code: 1, stdout: '', output: 'VM 200 not running' }) })
    const error = await refusal(admin.power('vm-1', 'off', false))
    expect(error.code).toBe('power_failed')
    expect(error.extra).toMatchObject({ reason: 'VM 200 not running' })
  })

  it('rejects an unknown action', async () => {
    const { admin } = setup()
    expect((await refusal(admin.power('vm-1', 'reboot', false))).status).toBe(400)
  })
})

describe('sign in and out', () => {
  it('ends a sign-in session once its shell has exited, and only then', async () => {
    let status = 'running'
    const { admin, peerCalls, sessions, timers } = setup({
      peer: (method, path) => {
        if (path === '/v1/sessions')
          return { status: 201, body: { id: 'abcd1234', generation: 'g1', status: 'running' } }
        if (method === 'GET')
          return { status: 200, body: { generation: status === 'running' ? 'g1' : 'g2', status } }
        return { status: 200, body: { status: 'ended' } }
      },
    })
    await admin.signInOut('vm-1', 'codex', { action: 'sign_in' })
    const tick = async () => {
      timers.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await tick()
    expect(peerCalls.map((call) => call.path)).not.toContain('/v1/sessions/abcd1234/end')
    expect(timers).toHaveLength(1)
    status = 'uncertain'
    sessions.mockClear()
    await tick()
    expect(peerCalls.at(-1)).toEqual({
      method: 'POST',
      path: '/v1/sessions/abcd1234/end',
      body: { generation: 'g2' },
    })
    expect(sessions).toHaveBeenCalled()
    expect(timers).toHaveLength(0)
  })

  it('stops following a sign-in session that was ended elsewhere', async () => {
    const { admin, peerCalls, timers } = setup({
      peer: (method, path) =>
        path === '/v1/sessions'
          ? { status: 201, body: { id: 'abcd1234', generation: 'g1', status: 'running' } }
          : method === 'GET'
            ? { status: 404, body: { error: 'not_found' } }
            : { status: 200, body: {} },
    })
    await admin.signInOut('vm-1', 'codex', { action: 'sign_in' })
    timers.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(peerCalls.map((call) => call.path)).not.toContain('/v1/sessions/abcd1234/end')
    expect(timers).toHaveLength(0)
  })

  it('signs in with a shell session on the host running the tool login', async () => {
    const { admin, peerCalls, sessions, fetches } = setup()
    const [status, answer] = await admin.signInOut('vm-1', 'codex', {
      action: 'sign_in',
      size: { cols: 80, rows: 24 },
    })
    expect(status).toBe(201)
    expect(answer).toMatchObject({ host: 'vm-1', session: { id: 'abcd1234', host: 'vm-1' } })
    expect(peerCalls[0]).toEqual({
      method: 'POST',
      path: '/v1/sessions',
      body: { tool: 'shell', name: 'Sign in: codex', origin: 'aico', size: { cols: 80, rows: 24 } },
    })
    expect(peerCalls[1]).toEqual({
      method: 'POST',
      path: '/v1/sessions/abcd1234/inject',
      body: {
        generation: 'g1',
        text: 'codex login --device-auth && exit',
        mode: 'paste',
        submit: true,
      },
    })
    expect(sessions).toHaveBeenCalled()
    expect(fetches).toEqual([])
  })

  it('pushes a stored tool login without opening a sign-in session', async () => {
    const { admin, fetches, peerCalls } = setup()
    const [status, answer] = await admin.signInOut('vm-1', 'claude-code', { action: 'sign_in' })
    expect(status).toBe(200)
    expect(answer).toMatchObject({ signedIn: true })
    expect(fetches).toMatchObject([{ url: 'vm-1/claude-code', method: 'PUT' }])
    expect(peerCalls).toEqual([])
  })

  it('opens no session when tool login delivery fails', async () => {
    const { admin, peerCalls } = setup({
      grant: async () => {
        throw new HttpError(502, 'login_delivery_failed')
      },
    })
    expect(
      (await refusal(admin.signInOut('vm-1', 'claude-code', { action: 'sign_in' }))).code,
    ).toBe('login_delivery_failed')
    expect(peerCalls).toEqual([])
  })

  it('marks the session when the login could not be typed in', async () => {
    const { admin } = setup({
      peer: (_method, path) =>
        path === '/v1/sessions'
          ? { status: 201, body: { id: 'abcd1234', generation: 'g1' } }
          : { status: 409, body: { error: 'workload_unavailable', reason: 'not running' } },
    })
    const [, answer] = await admin.signInOut('vm-1', 'codex', { action: 'sign_in' })
    expect(answer).toMatchObject({
      session: { failure: { code: 'inject_failed', reason: 'not running' } },
    })
  })

  it('signs a served tool out by revoking the grant and refreshing the shims', async () => {
    const { admin, fetches, runs } = setup()
    const [status, answer] = await admin.signInOut('vm-1', 'claude-code', { action: 'sign_out' })
    expect(status).toBe(200)
    expect(answer).toEqual({ host: 'vm-1', tool: 'claude-code', signedOut: true })
    expect(fetches[0]?.method).toBe('DELETE')
    expect(runs).toEqual([])
  })

  it('revokes even while the host is away, and says the shims wait', async () => {
    const { admin, runs } = setup({ state: 'powered_off' })
    const [, answer] = await admin.signInOut('vm-1', 'claude-code', { action: 'sign_out' })
    expect(answer).toMatchObject({
      signedOut: true,
      note: expect.stringContaining('not reachable'),
    })
    expect(runs).toEqual([])
  })

  it('runs a rotating tool logout on the host', async () => {
    const { admin, runs } = setup()
    await admin.signInOut('vm-1', 'codex', { action: 'sign_out' })
    expect(runs[0]).toEqual(remoteArgv(ENTRY, CONTROL, 'codex logout'))
  })

  it('opens a session for a tool that signs out inside its own UI', async () => {
    const { admin, peerCalls } = setup()
    const [status] = await admin.signInOut('vm-1', 'pi', { action: 'sign_out' })
    expect(status).toBe(201)
    expect(peerCalls[0]?.body).toMatchObject({ name: 'Sign out: pi' })
  })

  it('refuses unknown tools and actions', async () => {
    const { admin } = setup()
    expect((await refusal(admin.signInOut('vm-1', 'nope', { action: 'sign_in' }))).status).toBe(404)
    expect((await refusal(admin.signInOut('vm-1', 'codex', { action: 'x' }))).status).toBe(400)
    expect((await refusal(admin.signInOut('vm-1', '../x', { action: 'sign_in' }))).status).toBe(400)
  })
})

describe('helpers', () => {
  it('quotes the remote line for the login shell', () => {
    const argv = remoteArgv(ENTRY, CONTROL, "echo 'hi'; pi")
    expect(argv.slice(-3)).toEqual(['bash', '-lc', "echo 'hi'; pi"])
  })

  it('reads the JSON object from the status output', () => {
    expect(parseStatus('note\n{"tools": []}\n')).toEqual({ tools: [] })
    expect(parseStatus('no json')).toBeNull()
  })

  it('lets host-logins.json override a tool and ignores a broken file', () => {
    const custom = { codex: { signIn: 'codex login', signOut: null } }
    const read = (path: string) => {
      expect(path).toBe('/cfg/tether/host-logins.json')
      return JSON.stringify(custom)
    }
    const logins = loadLogins({ XDG_CONFIG_HOME: '/cfg' }, read, () => {}, TEST_LOGINS)
    expect(logins.codex).toEqual(custom.codex)
    expect(logins.pi).toEqual(TEST_LOGINS.pi)
    const log = vi.fn()
    expect(loadLogins({ XDG_CONFIG_HOME: '/cfg' }, () => '[', log, TEST_LOGINS)).toBe(TEST_LOGINS)
    expect(log).toHaveBeenCalled()
  })
})
