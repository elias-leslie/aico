import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSidecarLink } from './sidecar-link'

function setup(o: { packaged?: boolean } = {}) {
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
    SidecarCtor: FakeSidecar as never,
  })
  return { link, sidecars }
}

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
})
