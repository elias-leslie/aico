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
