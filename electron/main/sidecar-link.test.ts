import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSidecarLink } from './sidecar-link'

function setup(o: { packaged?: boolean } = {}) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({}) as Response)
  const sidecars: FakeSidecar[] = []
  class FakeSidecar {
    ready = false
    start = vi.fn(async () => true)
    stop = vi.fn()
    constructor(public options: unknown) {
      sidecars.push(this)
    }
  }
  const link = createSidecarLink({
    host: '127.0.0.1',
    port: 18905,
    stateDir: '/state',
    app: { isPackaged: o.packaged ?? false, getAppPath: () => '/repo' },
    resourcesPath: '/res',
    fetch: fetch as unknown as typeof globalThis.fetch,
    SidecarCtor: FakeSidecar as never,
  })
  return { link, fetch, sidecars }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => vi.restoreAllMocks())

describe('sidecar link', () => {
  it('starts the dev sidecar from the repo and the packaged one from resources', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dev = setup()
    dev.link.start()
    expect(dev.sidecars[0].options).toEqual({
      host: '127.0.0.1',
      port: 18905,
      repoRoot: '/repo',
      stateDir: '/state',
      command: undefined,
      args: undefined,
    })
    expect(dev.sidecars[0].start).toHaveBeenCalledTimes(1)
    const packaged = setup({ packaged: true })
    packaged.link.start()
    expect(packaged.sidecars[0].options).toMatchObject({ repoRoot: '/res', args: [] })
    expect(String((packaged.sidecars[0].options as { command: string }).command)).toContain('/res')
  })

  it('is ready only once its own sidecar is healthy', () => {
    const { link, sidecars } = setup()
    expect(link.ready()).toBe(false)
    link.start()
    expect(link.ready()).toBe(false)
    sidecars[0].ready = true
    expect(link.ready()).toBe(true)
    expect(link.url('/selection/current')).toBe('http://127.0.0.1:18905/selection/current')
  })

  it('stop() is safe before start, and later stops the sidecar', () => {
    const { link, sidecars } = setup()
    expect(() => link.stop()).not.toThrow()
    link.start()
    link.stop()
    expect(sidecars[0].stop).toHaveBeenCalledTimes(1)
  })

  it('posts a widget event with a 2 s timeout and swallows errors', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const { link, fetch } = setup()
    fetch.mockRejectedValueOnce(new Error('refused'))
    link.logEvent('a b', 'lifecycle_retired', { reason: 'ended' })
    await flush()
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:18905/widgets/a%20b/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'lifecycle_retired', data: { reason: 'ended' } }),
      signal: expect.any(AbortSignal),
    })
    expect(timeout).toHaveBeenCalledWith(2_000)
  })
})
