import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLifecycle } from './lifecycle'

type Listener = (...args: never[]) => void

function fakeApp(lock = true) {
  const listeners: [string, Listener][] = []
  return {
    listeners,
    of: (event: string) => listeners.filter(([e]) => e === event).map(([, fn]) => fn),
    emit(event: string, ...args: unknown[]) {
      for (const [e, fn] of listeners) if (e === event) (fn as (...a: unknown[]) => void)(...args)
    },
    requestSingleInstanceLock: vi.fn(() => lock),
    on: vi.fn((event: string, fn: Listener) => {
      listeners.push([event, fn])
    }),
    exit: vi.fn(),
    quit: vi.fn(),
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aico-lifecycle-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function setup(
  o: {
    lock?: boolean
    argv?: string[]
    activationReadyFile?: string
    pidFile?: string
    startTime?: string | null
  } = {},
) {
  const app = fakeApp(o.lock ?? true)
  const signals = new Map<string, Listener>()
  const dialog = { showErrorBox: vi.fn() }
  const removeOwnPidFile = vi.fn(() => true)
  const lifecycle = createLifecycle({
    app,
    dialog,
    argv: o.argv ?? ['electron', '.'],
    config: { activationReadyFile: o.activationReadyFile, pidFile: o.pidFile },
    onSignal: (signal, fn) => {
      signals.set(signal, fn)
    },
    startTime: () => (o.startTime === undefined ? '777' : o.startTime),
    removeOwnPidFile,
    fs: { readFileSync, writeFileSync, renameSync, unlinkSync },
  })
  return { app, signals, dialog, removeOwnPidFile, lifecycle }
}

describe('lifecycle: which process this is', () => {
  it('is the runtime owner with the lock and no --aico-activate', () => {
    const { app, lifecycle } = setup()
    expect(lifecycle.runtimeOwner).toBe(true)
    expect(app.exit).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
    expect(lifecycle.ownProcess).toEqual({ pid: process.pid, startTime: '777' })
  })

  it('an activation helper holding the lock exits(1) and never becomes the runtime', () => {
    const { app, lifecycle } = setup({ argv: ['electron', '.', '--aico-activate'] })
    expect(lifecycle.runtimeOwner).toBe(false)
    expect(app.exit).toHaveBeenCalledWith(1)
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('a duplicate without the lock quits', () => {
    const { app, lifecycle } = setup({ lock: false })
    expect(lifecycle.runtimeOwner).toBe(false)
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('a click with --aico-activate on a running Aico just quits as a duplicate', () => {
    const { app, lifecycle } = setup({ lock: false, argv: ['electron', '.', '--aico-activate'] })
    expect(lifecycle.runtimeOwner).toBe(false)
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.exit).not.toHaveBeenCalled()
  })
})

describe('lifecycle: listeners', () => {
  it('registers signals, the lock, then the listeners in order', () => {
    const { app, signals } = setup()
    expect([...signals.keys()]).toEqual(['SIGTERM', 'SIGINT'])
    expect(app.listeners.map(([event]) => event)).toEqual([
      'before-quit',
      'second-instance',
      'activate',
      'before-quit',
      'before-quit',
      'window-all-closed',
    ])
  })

  it('keeps a window-all-closed listener so closing the last window does not quit', () => {
    const { app } = setup()
    expect(app.of('window-all-closed')).toHaveLength(1)
    app.emit('window-all-closed')
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('a signal asks for one graceful quit', () => {
    const { app, signals } = setup()
    signals.get('SIGTERM')?.()
    signals.get('SIGINT')?.()
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledWith('[aico:lifecycle] graceful SIGTERM shutdown requested')
  })
})

describe('lifecycle: quit', () => {
  it('sets quitting before the first teardown runs, then runs teardown in order', () => {
    const { app, lifecycle } = setup()
    const seen: string[] = []
    lifecycle.onQuit(() => seen.push(`a:${lifecycle.isQuitting()}`))
    lifecycle.onQuit(() => seen.push(`b:${lifecycle.isQuitting()}`))
    expect(lifecycle.isQuitting()).toBe(false)
    app.emit('before-quit')
    expect(seen).toEqual(['a:true', 'b:true'])
  })

  it('runs teardown in a helper process too', () => {
    const { app, lifecycle } = setup({ argv: ['electron', '.', '--aico-activate'] })
    const teardown = vi.fn()
    lifecycle.onQuit(teardown)
    app.emit('before-quit')
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('the pidfile and activation cleanup are their own before-quit listeners', () => {
    const ready = join(dir, 'ready')
    const { app, lifecycle, removeOwnPidFile } = setup({
      activationReadyFile: ready,
      pidFile: join(dir, 'pid'),
    })
    lifecycle.onQuit(() => {
      throw new Error('teardown broke')
    })
    const [first, second, third] = app.of('before-quit')
    expect(first).toThrow('teardown broke')
    second()
    expect(removeOwnPidFile).toHaveBeenCalledWith(join(dir, 'pid'))
    third()
    expect(() => statSync(ready)).toThrow()
  })

  it('removes the pidfile only as the runtime owner', () => {
    const owner = setup({ pidFile: '/r/pid' })
    owner.app.emit('before-quit')
    expect(owner.removeOwnPidFile).toHaveBeenCalledWith('/r/pid')
    const helper = setup({ pidFile: '/r/pid', argv: ['electron', '.', '--aico-activate'] })
    helper.app.emit('before-quit')
    expect(helper.removeOwnPidFile).not.toHaveBeenCalled()
  })
})

describe('lifecycle: activation readiness file', () => {
  it('publishes pid and start time, mode 0600, and removes it at quit', () => {
    const ready = join(dir, 'ready')
    const { app } = setup({ activationReadyFile: ready })
    expect(readFileSync(ready, 'utf8')).toBe(`${process.pid} 777\n`)
    expect(statSync(ready).mode & 0o777).toBe(0o600)
    app.emit('before-quit')
    expect(() => statSync(ready)).toThrow()
  })

  it('leaves a file a newer runtime wrote', () => {
    const ready = join(dir, 'ready')
    const { app } = setup({ activationReadyFile: ready })
    writeFileSync(ready, '1 2\n')
    app.emit('before-quit')
    expect(readFileSync(ready, 'utf8')).toBe('1 2\n')
  })

  it('is not published by a helper or without a start time', () => {
    const ready = join(dir, 'ready')
    setup({ activationReadyFile: ready, argv: ['electron', '.', '--aico-activate'] })
    expect(() => statSync(ready)).toThrow()
    setup({ activationReadyFile: ready, startTime: null })
    expect(() => statSync(ready)).toThrow()
    expect(console.warn).toHaveBeenCalledWith(
      '[aico] could not publish activation readiness:',
      expect.objectContaining({ message: 'missing process starttime' }),
    )
  })
})

describe('lifecycle: activation', () => {
  it('queues an activation that arrives before startup is done and runs it once', () => {
    const { app, lifecycle } = setup()
    const activate = vi.fn()
    lifecycle.setActivationHandler(activate)
    app.emit('second-instance')
    app.emit('activate')
    expect(activate).not.toHaveBeenCalled()
    lifecycle.markReady()
    expect(activate).toHaveBeenCalledTimes(1)
    lifecycle.markReady()
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('activates directly once ready', () => {
    const { app, lifecycle } = setup()
    const activate = vi.fn()
    lifecycle.setActivationHandler(activate)
    lifecycle.markReady()
    expect(activate).not.toHaveBeenCalled()
    app.emit('second-instance')
    app.emit('activate')
    expect(activate).toHaveBeenCalledTimes(2)
  })
})

describe('lifecycle: indicate shortcut', () => {
  it('a second launch with --aico-indicate runs the indicate handler, not an activation', () => {
    const { app, lifecycle } = setup()
    const activate = vi.fn()
    const indicate = vi.fn()
    lifecycle.setActivationHandler(activate)
    lifecycle.setIndicateHandler(indicate)
    app.emit('second-instance', {}, ['electron', '.', '--aico-indicate'])
    expect(indicate).not.toHaveBeenCalled() // not ready: dropped, never queued
    lifecycle.markReady()
    app.emit('second-instance', {}, ['electron', '.', '--aico-indicate'])
    expect(indicate).toHaveBeenCalledTimes(1)
    expect(activate).not.toHaveBeenCalled()
  })

  it('the --aico-indicate helper never becomes the runtime', () => {
    const { app, lifecycle } = setup({ lock: false, argv: ['electron', '.', '--aico-indicate'] })
    expect(lifecycle.runtimeOwner).toBe(false)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })
})

describe('lifecycle: failed startup', () => {
  it('logs, says why and exits so the next launch starts clean', () => {
    const { app, dialog, lifecycle } = setup()
    const error = new Error('initViews failed')
    lifecycle.failStartup(error)
    expect(console.error).toHaveBeenCalledWith('[aico] startup failed:', error)
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'Aico could not start',
      'initViews failed\n\nYour sessions are still running. Fix the cause and open Aico again.',
    )
    expect(app.exit).toHaveBeenCalledWith(1)
  })

  it('exits even when the dialog throws', () => {
    const { app, dialog, lifecycle } = setup()
    dialog.showErrorBox.mockImplementation(() => {
      throw new Error('no display')
    })
    expect(() => lifecycle.failStartup('x')).toThrow('no display')
    expect(app.exit).toHaveBeenCalledWith(1)
  })
})
