import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { healthUrl, resolvePython, Sidecar, sidecarArgs, waitForHealth } from './sidecar'

describe('sidecar helpers', () => {
  it('resolves the venv interpreter by default', () => {
    expect(resolvePython('/opt/aico', {})).toBe('/opt/aico/.venv/bin/python')
  })

  it('honors an explicit interpreter override', () => {
    expect(resolvePython('/opt/aico', { AICO_SIDECAR_PYTHON: '/usr/bin/python3' })).toBe(
      '/usr/bin/python3',
    )
  })

  it('runs the sidecar as a module', () => {
    expect(sidecarArgs()).toEqual(['-m', 'aico_sidecar'])
  })

  it('builds the health URL', () => {
    expect(healthUrl('127.0.0.1', 8005)).toBe('http://127.0.0.1:8005/health')
  })
})

describe('waitForHealth', () => {
  it('resolves true as soon as a 200 is returned', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true } as Response)
    await expect(waitForHealth('http://x/health', { fetchFn })).resolves.toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('retries past connection errors until healthy', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ ok: true } as Response)
    await expect(waitForHealth('http://x/health', { fetchFn, intervalMs: 1 })).resolves.toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('gives up after the timeout', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(
      waitForHealth('http://x/health', { fetchFn, timeoutMs: 5, intervalMs: 1 }),
    ).resolves.toBe(false)
  })
})

/** A stand-in for the spawned child: an EventEmitter with pipe-able std streams
 *  and a kill() that emulates the OS delivering the signal (async `exit`). */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn((_sig?: string) => {
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))
    return true
  })
  return child
}

const OPTS = { host: '127.0.0.1', port: 8005, repoRoot: '/opt/aico', stateDir: '/tmp/state' }

describe('Sidecar', () => {
  it('reports ready and stays alive when health passes', async () => {
    const child = fakeChild()
    const status = vi.fn()
    const sc = new Sidecar(OPTS, status, {
      spawn: vi.fn(() => child) as never,
      waitForHealth: async () => true,
    })
    await expect(sc.start()).resolves.toBe(true)
    expect(status).toHaveBeenCalledWith('ready', healthUrl('127.0.0.1', 8005))
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('kills a hung child when the health gate times out (no port leak)', async () => {
    const child = fakeChild()
    const status = vi.fn()
    const sc = new Sidecar(OPTS, status, {
      spawn: vi.fn(() => child) as never,
      waitForHealth: async () => false,
    })
    await expect(sc.start()).resolves.toBe(false)
    expect(status).toHaveBeenCalledWith('unhealthy', 'health gate timed out')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('classifies a signal-terminated crash (code === null) as crashed', async () => {
    const child = fakeChild()
    const status = vi.fn()
    const sc = new Sidecar(OPTS, status, {
      spawn: vi.fn(() => child) as never,
      waitForHealth: async () => true,
    })
    await sc.start()
    child.emit('exit', null, 'SIGSEGV')
    expect(status).toHaveBeenCalledWith('crashed', 'signal SIGSEGV')
  })

  it('classifies a non-zero exit code as crashed', async () => {
    const child = fakeChild()
    const status = vi.fn()
    const sc = new Sidecar(OPTS, status, {
      spawn: vi.fn(() => child) as never,
      waitForHealth: async () => true,
    })
    await sc.start()
    child.emit('exit', 3, null)
    expect(status).toHaveBeenCalledWith('crashed', 'exit 3')
  })

  it('does not report a crash for an intentional stop()', async () => {
    const child = fakeChild()
    const status = vi.fn()
    const sc = new Sidecar(OPTS, status, {
      spawn: vi.fn(() => child) as never,
      waitForHealth: async () => true,
    })
    await sc.start()
    sc.stop()
    await new Promise((r) => setTimeout(r, 0)) // let the fake child's exit fire
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(status).not.toHaveBeenCalledWith('crashed', expect.anything())
  })
})
