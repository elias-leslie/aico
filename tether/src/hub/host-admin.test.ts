import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '../http'
import {
  DEFAULT_LOGINS,
  HostAdmin,
  type HostAdminDeps,
  loadLogins,
  parseStatus,
  type RunResult,
  remoteArgv,
} from './host-admin'
import type { HostEntry } from './hosts'
import type { PeerAnswer } from './peer-http'

const ENTRY: HostEntry = {
  name: 'vm-1',
  ssh: 'vm-1',
  socket: '/run/user/1000/tether/default/control.sock',
  forwards: [],
  wake: ['st', 'vm', 'start', '200'],
  sleep: ['st', 'vm', 'shutdown', '200'],
  health: [],
  wakeTimeoutSec: 240,
  stateDir: null,
}
const CONTROL = '/run/user/1000/tether/peers/vm-1/ssh.ctl'

const STATUS = {
  host: 'vm-1',
  agent_hub: 'reachable',
  tools: [{ tool: 'codex', state: 'needs_sign_in', source: 'host:/home/u/.codex/auth.json' }],
}

function setup(
  options: {
    state?: string
    sessions?: Record<string, unknown>[]
    run?: (argv: string[]) => RunResult
    peer?: (method: string, path: string, body: unknown) => PeerAnswer
    fetch?: (url: string, init: RequestInit) => Response
  } = {},
) {
  const runs: string[][] = []
  const peerCalls: { method: string; path: string; body: unknown }[] = []
  const fetches: { url: string; method: string; headers: Record<string, string> }[] = []
  const wakeHost = vi.fn(async () => {})
  const sessions = vi.fn(async () => options.sessions ?? [])
  const deps: HostAdminDeps = {
    hub: {
      hosts: () => [{ name: 'vm-1', state: options.state ?? 'connected', control: CONTROL }],
      hostEntry: (name) => (name === 'vm-1' ? ENTRY : null),
      wakeHost,
      sessions,
    },
    agentHub: {
      baseUrl: 'http://127.0.0.1:8003',
      clientId: 'client-1',
      requestSource: 'aico-tether',
      ownerTokenFile: '/tokens/owner',
    },
    env: { HOME: '/home/u', XDG_CONFIG_HOME: '/cfg' },
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
    fetch: (async (url: string, init: RequestInit) => {
      fetches.push({
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
      })
      return options.fetch?.(url, init) ?? new Response('{}', { status: 200 })
    }) as typeof fetch,
    readFile: (path) => {
      if (path === '/tokens/owner') return 'owner-secret\n'
      throw new Error('ENOENT')
    },
    log: () => {},
  }
  return { admin: new HostAdmin(deps), runs, peerCalls, fetches, wakeHost, sessions }
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
  it('runs agent-hub on the host through the link and returns its answer', async () => {
    const { admin, runs } = setup()
    const answer = await admin.status('vm-1')
    expect(runs[0]).toEqual(remoteArgv(ENTRY, CONTROL, 'agent-hub login status --json'))
    expect(runs[0]?.slice(0, 9)).toEqual([
      '/usr/bin/ssh',
      '-F',
      '/dev/null',
      '-T',
      '-o',
      'BatchMode=yes',
      '-S',
      CONTROL,
      'vm-1',
    ])
    expect(answer).toMatchObject({ ...STATUS, host: 'vm-1' })
    expect(answer.actions).toMatchObject({
      'claude-code': { signIn: true, signOut: 'revoke' },
      codex: { signIn: true, signOut: 'command' },
      pi: { signIn: true, signOut: 'session' },
    })
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
      run: () => ({ code: 127, stdout: '', output: 'agent-hub: not found' }),
    })
    const error = await refusal(failing.admin.status('vm-1'))
    expect(error.status).toBe(502)
    expect(error.extra).toMatchObject({ reason: 'agent-hub: not found' })
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
      { id: 'a', host: 'vm-1', status: 'running' },
      { id: 'b', host: 'vm-1', status: 'ended' },
      { id: 'c', host: null, status: 'running' },
    ]
    const { admin, runs } = setup({ sessions })
    const error = await refusal(admin.power('vm-1', 'off', false))
    expect(error.status).toBe(409)
    expect(error.code).toBe('host_busy')
    expect(error.extra).toMatchObject({ sessions: 1, reason: '1 session running on vm-1' })
    expect(runs).toEqual([])
    const [status, answer] = await admin.power('vm-1', 'off', true)
    expect(status).toBe(200)
    expect(answer).toMatchObject({ state: 'powering_off', sessions: 1 })
    expect(runs).toEqual([['st', 'vm', 'shutdown', '200']])
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
      body: { generation: 'g1', text: 'codex login --device-auth', mode: 'paste', submit: true },
    })
    expect(sessions).toHaveBeenCalled()
    expect(fetches).toEqual([])
  })

  it('grants a served tool before its sign-in, with the owner token', async () => {
    const { admin, fetches, peerCalls } = setup()
    await admin.signInOut('vm-1', 'claude-code', { action: 'sign_in' })
    expect(fetches[0]).toMatchObject({
      url: 'http://127.0.0.1:8003/api/remote-hosts/vm-1/tools/claude-code',
      method: 'PUT',
      headers: {
        'X-Agent-Hub-Owner-Token': 'owner-secret',
        'X-Client-Id': 'client-1',
        'X-Request-Source': 'aico-tether',
      },
    })
    expect(peerCalls[1]?.body).toMatchObject({ text: DEFAULT_LOGINS['claude-code']?.signIn })
  })

  it('opens no session when Agent Hub refuses the grant', async () => {
    const { admin, peerCalls } = setup({
      fetch: () => new Response(JSON.stringify({ detail: 'unknown host' }), { status: 404 }),
    })
    const error = await refusal(admin.signInOut('vm-1', 'claude-code', { action: 'sign_in' }))
    expect(error.code).toBe('agent_hub_refused')
    expect(error.extra).toMatchObject({ reason: 'unknown host' })
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
    expect(runs[0]).toEqual(remoteArgv(ENTRY, CONTROL, 'agent-hub install'))
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
    expect(argv.at(-1)).toBe(`bash -lc 'echo '\\''hi'\\''; pi'`)
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
    const logins = loadLogins({ XDG_CONFIG_HOME: '/cfg' }, read, () => {})
    expect(logins.codex).toEqual(custom.codex)
    expect(logins.pi).toEqual(DEFAULT_LOGINS.pi)
    const log = vi.fn()
    expect(loadLogins({ XDG_CONFIG_HOME: '/cfg' }, () => '[', log)).toBe(DEFAULT_LOGINS)
    expect(log).toHaveBeenCalled()
  })
})
