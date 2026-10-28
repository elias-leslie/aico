import { describe, expect, it, vi } from 'vitest'
import type { AicoApi } from '../types'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
    send: electron.send,
  },
}))

await import('./index')

describe('preload session diagnostics bridge', () => {
  it('exposes the narrow session:diagnostics invoke channel', async () => {
    const exposed = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'aico')
    const api = exposed?.[1] as AicoApi
    const diagnostics = { capturedAt: '2026-07-13T12:00:00.000Z', warnings: [] }
    electron.invoke.mockResolvedValueOnce(diagnostics)

    await expect(api.actions.sessionDiagnostics()).resolves.toBe(diagnostics)
    expect(electron.invoke).toHaveBeenCalledWith('session:diagnostics')
  })
})

describe('preload chat bridge', () => {
  const api = () =>
    electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'aico')?.[1] as AicoApi

  it('offers the renderer three calls and no credential or address', () => {
    expect(Object.keys(api().chat).sort()).toEqual(['call', 'info', 'openStream'])
    const exposed = JSON.stringify(Object.keys(api()))
    expect(exposed).not.toMatch(/token|owner/i)
  })

  it('keeps events that arrive before the stream id and drops other streams', async () => {
    electron.on.mockClear()
    electron.invoke.mockImplementationOnce(async () => {
      const listener = electron.on.mock.calls.find(([channel]) => channel === 'chat:event')?.[1]
      // One event for this stream arrives before the invoke answers, one for another stream.
      listener({}, 's1', { kind: 'event', event: { type: 'content', seq: 1 } })
      listener({}, 's9', { kind: 'event', event: { type: 'content', seq: 99 } })
      return 's1'
    })
    const items: unknown[] = []
    const close = await api().chat.openStream(0, (item) => items.push(item))
    const listener = electron.on.mock.calls.find(([channel]) => channel === 'chat:event')?.[1]
    listener({}, 's1', { kind: 'end' })
    listener({}, 's2', { kind: 'end' })

    expect(electron.invoke).toHaveBeenCalledWith('chat:stream-open', 0)
    expect(items).toEqual([{ kind: 'event', event: { type: 'content', seq: 1 } }, { kind: 'end' }])
    close()
    expect(electron.removeListener).toHaveBeenCalledWith('chat:event', listener)
    expect(electron.send).toHaveBeenCalledWith('chat:stream-close', 's1')
  })

  it('reports a refused stream as an error item and leaves no listener behind', async () => {
    electron.removeListener.mockClear()
    electron.invoke.mockResolvedValueOnce({ code: 'not_a_chat', message: 'no' })
    const items: unknown[] = []
    await api().chat.openStream(0, (item) => items.push(item))
    expect(items).toEqual([{ kind: 'error', error: { code: 'not_a_chat', message: 'no' } }])
    expect(electron.removeListener).toHaveBeenCalled()
  })
})
