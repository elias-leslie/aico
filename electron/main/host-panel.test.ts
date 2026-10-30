import { TetherError } from 'tether/client'
import { describe, expect, it, vi } from 'vitest'
import { createHostPanel } from './host-panel'

type Handler = (...args: unknown[]) => Promise<unknown>

function setup(request: (method: string, path: string, body?: unknown) => unknown) {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (name: string, fn: Handler) => handlers.set(name, fn) }
  const calls: unknown[][] = []
  const tether = {
    hosts: async () => [
      {
        name: 'agent-work',
        state: 'connected',
        since: 1,
        sessions: 2,
        error: null,
        ssh: 'x',
        control: 'y',
        listedAt: 1,
      },
    ],
    request: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body])
      const answer = request(method, path, body)
      if (answer instanceof Error) throw answer
      return { status: 200, body: answer }
    },
  }
  const catalog = { upsert: vi.fn() }
  const windows = { focusOrReopen: vi.fn() }
  const broadcast = vi.fn()
  const panel = createHostPanel({ tether: tether as never, catalog, windows, broadcast })
  panel.registerIpc(ipcMain as never)
  const call = (name: string, ...args: unknown[]) => handlers.get(name)?.({}, ...args)
  return { panel, call, calls, catalog, windows, broadcast }
}

describe('hosts panel IPC', () => {
  it('lists hosts with their sessions and start progress', async () => {
    const { call } = setup(() => ({}))
    expect(await call('hosts:panel')).toEqual({
      ok: true,
      value: [
        { name: 'agent-work', state: 'connected', since: 1, sessions: 2, error: null, wake: null },
      ],
    })
  })

  it('opens a sign-in session in a window and tells every window when it ends', async () => {
    const session = { id: 'abcd1234', generation: 'g', status: 'running', host: 'agent-work' }
    const { call, calls, catalog, windows, broadcast, panel } = setup(() => ({
      host: 'agent-work',
      session,
    }))
    const answer = await call('hosts:sign', 'agent-work', 'codex', 'sign_in')
    expect(answer).toEqual({ ok: true, value: { signedOut: false, note: null, opened: true } })
    expect(calls[0]).toEqual([
      'POST',
      '/v1/hosts/agent-work/logins/codex',
      { action: 'sign_in', origin: 'aico' },
    ])
    expect(catalog.upsert).toHaveBeenCalledWith(session)
    expect(windows.focusOrReopen).toHaveBeenCalledWith('abcd1234')
    panel.sessionRemoved('ffffffff')
    expect(broadcast).not.toHaveBeenCalled()
    panel.sessionRemoved('abcd1234')
    expect(broadcast).toHaveBeenCalledWith('agent-work')
  })

  it('passes Tether’s reason and status through, and refuses bad input', async () => {
    const { call } = setup(
      () => new TetherError(409, 'host_busy', { reason: '2 sessions running on agent-work' }),
    )
    expect(await call('hosts:power', 'agent-work', 'off', false)).toEqual({
      ok: false,
      status: 409,
      message: '2 sessions running on agent-work',
    })
    expect(await call('hosts:power', 'agent-work', 'reboot')).toMatchObject({
      ok: false,
      status: 400,
    })
    expect(await call('hosts:logins', '../etc')).toMatchObject({ ok: false, status: 400 })
    expect(await call('hosts:sign', 'agent-work', 'Codex!', 'sign_in')).toMatchObject({ ok: false })
  })
})
