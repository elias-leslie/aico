// This process as the Aico desktop runtime, a launcher click or a duplicate:
// the single-instance lock, activation, the readiness and pid files, signals,
// and the order things stop in at quit.

import type { AicoConfig } from './config'

interface AppLike {
  requestSingleInstanceLock(): boolean
  on(event: 'before-quit' | 'activate' | 'window-all-closed', listener: () => void): unknown
  on(event: 'second-instance', listener: (event: unknown, argv: string[]) => void): unknown
  exit(code: number): void
  quit(): void
}

interface LifecycleDeps {
  app: AppLike
  dialog: { showErrorBox(title: string, content: string): void }
  argv: string[]
  config: Pick<AicoConfig, 'activationReadyFile' | 'pidFile'>
  onSignal(signal: NodeJS.Signals, listener: () => void): void
  startTime(): string | null
  removeOwnPidFile(path: string): boolean
  fs: {
    readFileSync(path: string, encoding: 'utf8'): string
    writeFileSync(path: string, data: string, options: { mode: number }): void
    renameSync(from: string, to: string): void
    unlinkSync(path: string): void
  }
}

export interface Lifecycle {
  /** This process is the desktop runtime, not a launcher click or a duplicate. */
  readonly runtimeOwner: boolean
  readonly ownProcess: { pid: number; startTime: string | null }
  isQuitting(): boolean
  /** Runs, in registration order, inside the first before-quit listener, after quitting is set. */
  onQuit(fn: () => void): void
  /** What a desktop activation does once startup is done. */
  setActivationHandler(fn: () => void): void
  /** Startup is done: runs an activation that arrived meanwhile. */
  markReady(): void
  failStartup(error: unknown): void
}

/**
 * Takes the single-instance lock and registers the process listeners, all
 * synchronously: call it at module evaluation, before anything awaits.
 */
export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { app, fs } = deps
  // Written into layout.json: readers check this process is still alive before
  // trusting the file, since a SIGKILL or crash skips the unlink at quit.
  const ownProcess = { pid: process.pid, startTime: deps.startTime() }
  let quitting = false
  const quitFns: (() => void)[] = []
  let activationHandler: (() => void) | null = null

  let signalQuitRequested = false
  function requestGracefulSignalQuit(signal: NodeJS.Signals): void {
    if (signalQuitRequested) return
    signalQuitRequested = true
    console.log(`[aico:lifecycle] graceful ${signal} shutdown requested`)
    app.quit()
  }
  deps.onSignal('SIGTERM', () => requestGracefulSignalQuit('SIGTERM'))
  deps.onSignal('SIGINT', () => requestGracefulSignalQuit('SIGINT'))

  // Single-instance lock: a second launch must not spawn a duplicate (it would
  // fight over the listener port :8005 and re-adopt the same widget catalog). The
  // secondary quits immediately; the primary handles the desktop activation.
  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  // --aico-activate (a launcher click) is a message to the running runtime, never a runtime of its own.
  const activationOnly = deps.argv.includes('--aico-activate')
  const runtimeOwner = gotSingleInstanceLock && !activationOnly

  app.on('before-quit', () => {
    quitting = true
    for (const fn of quitFns) fn()
  })

  if (gotSingleInstanceLock && activationOnly) {
    // An activation helper must never become the desktop runtime if the managed
    // process exits between launcher verification and this lock request.
    app.exit(1)
  } else if (!gotSingleInstanceLock) app.quit()

  let activationReady = false
  let activationPending = false
  function activate(): void {
    if (!activationReady) {
      activationPending = true
      return
    }
    activationHandler?.()
  }

  app.on('second-instance', activate)
  app.on('activate', activate)

  const activationReadyFile = deps.config.activationReadyFile
  let activationIdentity: string | null = null
  if (runtimeOwner && activationReadyFile) {
    try {
      // The start time disambiguates a reused PID without exposing an
      // application or agent environment variable.
      if (!ownProcess.startTime) throw new Error('missing process starttime')
      activationIdentity = `${process.pid} ${ownProcess.startTime}\n`
      const temporary = `${activationReadyFile}.tmp.${process.pid}`
      fs.writeFileSync(temporary, activationIdentity, { mode: 0o600 })
      fs.renameSync(temporary, activationReadyFile)
    } catch (error) {
      console.warn('[aico] could not publish activation readiness:', error)
    }
  }
  // The foreground runner registers its own PID, which exec hands to Electron.
  // Clear it on a clean quit so the next start finds no stale pidfile.
  const runtimePidFile = deps.config.pidFile
  app.on('before-quit', () => {
    if (runtimeOwner && runtimePidFile) deps.removeOwnPidFile(runtimePidFile)
  })

  app.on('before-quit', () => {
    if (!activationReadyFile || !activationIdentity) return
    try {
      if (fs.readFileSync(activationReadyFile, 'utf8') === activationIdentity)
        fs.unlinkSync(activationReadyFile)
    } catch {
      // Startup may have failed before publication, or a restart replaced us.
    }
  })

  app.on('window-all-closed', () => {
    // Aico lives in the tray after the last widget closes; Quit (tray) exits.
  })

  return {
    runtimeOwner,
    ownProcess,
    isQuitting: () => quitting,
    onQuit: (fn) => {
      quitFns.push(fn)
    },
    setActivationHandler: (fn) => {
      activationHandler = fn
    },
    markReady: () => {
      activationReady = true
      if (activationPending) {
        activationPending = false
        activate()
      }
    },
    /**
     * Startup that throws part-way leaves no tray, IPC or control socket while the
     * process still holds the single-instance lock, so every later launch would be
     * swallowed by `second-instance`. Say why and exit so the next launch starts
     * clean; durable tmux sessions are untouched.
     */
    failStartup: (error) => {
      console.error('[aico] startup failed:', error)
      try {
        deps.dialog.showErrorBox(
          'Aico could not start',
          `${error instanceof Error ? error.message : String(error)}\n\nYour sessions are still running. Fix the cause and open Aico again.`,
        )
      } finally {
        app.exit(1)
      }
    },
  }
}
