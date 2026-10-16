// Aico's optional sidecar process as the rest of main sees it: starting it
// (the bundled executable when packaged, the repo's Python in dev), stopping
// it at quit, whether it is our own healthy instance, its URLs, and the
// bounded per-widget event log it keeps.

import type { App } from 'electron'
import { bundledSidecar, Sidecar } from './sidecar'

type SidecarLike = Pick<Sidecar, 'ready' | 'start' | 'stop'>

interface SidecarLinkDeps {
  host: string
  port: number
  stateDir: string
  app: Pick<App, 'isPackaged' | 'getAppPath'>
  resourcesPath: string
  fetch?: typeof fetch
  SidecarCtor?: new (...args: ConstructorParameters<typeof Sidecar>) => SidecarLike
}

export function createSidecarLink(deps: SidecarLinkDeps) {
  const { app } = deps
  const fetchImpl: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init))
  const SidecarCtor = deps.SidecarCtor ?? Sidecar
  const url = (path: string): string => `http://${deps.host}:${deps.port}${path}`

  let sidecar: SidecarLike | null = null

  return {
    url,
    /** Our own sidecar passed its health check. Nothing is read from a process Aico did not start. */
    ready: (): boolean => sidecar?.ready ?? false,

    start: (): void => {
      // Packaged: spawn the bundled PyInstaller executable from resources (no
      // Python needed). Dev: `app.getAppPath()` is the repo root, so
      // resolvePython finds the .venv and runs `-m aico_sidecar`. The packaged
      // spawn cwd is a real directory (resourcesPath) since app.asar isn't a
      // chdir-able path.
      const packaged = app.isPackaged
      sidecar = new SidecarCtor(
        {
          host: deps.host,
          port: deps.port,
          repoRoot: packaged ? deps.resourcesPath : app.getAppPath(),
          stateDir: deps.stateDir,
          command: packaged ? bundledSidecar(deps.resourcesPath) : undefined,
          args: packaged ? [] : undefined,
        },
        (status, detail) => console.log(`[aico] sidecar ${status}${detail ? `: ${detail}` : ''}`),
      )
      // Fire-and-forget: widgets render against tmux without the sidecar, so
      // don't gate the UI on it; the health result is logged via onStatus.
      sidecar.start().catch((err) => console.warn('[aico] sidecar start failed:', err))
    },

    /** Quit. Safe if never started. */
    stop: (): void => {
      sidecar?.stop()
    },

    /** The per-widget event log (the sidecar's bounded, rotated JSONL). */
    logEvent: (widgetId: string, event: string, data: Record<string, unknown>): void => {
      // The console line remains authoritative if the optional sidecar is unavailable.
      void fetchImpl(url(`/widgets/${encodeURIComponent(widgetId)}/events`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, data }),
        // The sidecar is optional. A wedged loopback listener must not retain an
        // unbounded fetch while Aico is trying to reconcile or retire a workload.
        signal: AbortSignal.timeout(2_000),
      }).catch(() => {})
    },
  }
}
