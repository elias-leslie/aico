// The selection bus, main's half: the optional sidecar Aico starts and its
// per-widget event log, the session an indicated selection goes to, the
// hotkey harvest and the browser-driven deliver-event stream that both type
// through Tether, and the desktop grab menu rows.

import { execFile as nodeExecFile } from 'node:child_process'
import { join } from 'node:path'
import type { App, IpcMain } from 'electron'
import { parseSse, type SelectionRecord } from './selection'
import { deliverSelectionToSession } from './selection-delivery'
import type { SessionCatalog } from './session-catalog'
import { bundledSidecar, Sidecar } from './sidecar'
import { type TetherClient, TetherError } from './tether-client'
import type { ViewRow } from './views'
import type { WindowRegistry } from './window-registry'

// Subscribe to the sidecar's deliver-event stream so a browser-side "send"
// (extension pill / right-click / picker) reaches the same insert path as the
// hotkey. Reconnects with backoff across sidecar restarts; cancelled on quit.
// This is also the Wayland-safe trigger (a CLI POST to /selection/send fires it).
// Only our own healthy sidecar is subscribed: if something else holds the port,
// its events must never be typed into an agent prompt. The sidecar pings every
// 15s, so a stream silent for SELECTION_EVENTS_IDLE_MS is half-open and is
// reconnected rather than silently dropping every later send.
const SELECTION_EVENTS_IDLE_MS = 45_000

type SidecarLike = Pick<Sidecar, 'ready' | 'start' | 'stop'>

interface SelectionBusDeps {
  registry: Pick<WindowRegistry, 'forSession'>
  catalog: Pick<SessionCatalog, 'get'>
  listViews(): ViewRow[]
  tether: Pick<TetherClient, 'inject'>
  isReplacing(id: string): boolean
  isQuitting(): boolean
  host: string
  port: number
  stateDir: string
  app: Pick<App, 'isPackaged' | 'getAppPath'>
  resourcesPath: string
  home: string
  env: NodeJS.ProcessEnv
  fetch?: typeof fetch
  execFile?: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
    callback: (error: Error | null) => void,
  ) => unknown
  SidecarCtor?: new (...args: ConstructorParameters<typeof Sidecar>) => SidecarLike
}

export function createSelectionBus(deps: SelectionBusDeps) {
  const { registry, catalog, app } = deps
  const fetchImpl: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init))
  const execFile = deps.execFile ?? nodeExecFile
  const SidecarCtor = deps.SidecarCtor ?? Sidecar

  let sidecar: SidecarLike | null = null

  const selectionDeliveries = new Map<string, Promise<void>>()

  // The widget that should receive an indicated selection: the last Aico widget
  // the user focused. (During an indicate gesture the *browser* holds OS focus,
  // so "active session" means most-recently-focused widget, not focused-now.)
  let lastFocusedAico: string | null = null
  // Aborts the sidecar SSE subscription (deliver-event stream) on quit.
  let selectionEvents: AbortController | null = null

  function logWidgetEvent(widgetId: string, event: string, data: Record<string, unknown>): void {
    // Reuse the sidecar's bounded, rotated per-widget JSONL implementation. The
    // console line remains authoritative if the optional sidecar is unavailable.
    void fetchImpl(
      `http://${deps.host}:${deps.port}/widgets/${encodeURIComponent(widgetId)}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, data }),
        // The sidecar is optional. A wedged loopback listener must not retain an
        // unbounded fetch while Aico is trying to reconcile or retire a workload.
        signal: AbortSignal.timeout(2_000),
      },
    ).catch(() => {})
  }

  // The widget that should receive an indicated selection: the last-focused one
  // if it's still open, else the most recently opened view.
  function selectionTarget(): string | undefined {
    if (lastFocusedAico && registry.forSession(lastFocusedAico)) return lastFocusedAico
    const open = deps.listViews().filter((view) => registry.forSession(view.id))
    return open.length ? open[open.length - 1].id : undefined
  }

  // Shared deliver path for every trigger (X11 hotkey + browser-driven SSE):
  // type a compact reference at the target session's prompt through Tether (no
  // Enter — the user adds their ask and submits), then flash a toast.
  function deliverSelection(records: SelectionRecord[]): void {
    if (!records.some((record) => record?.kind && record.kind !== 'empty')) return
    const targetId = selectionTarget()
    if (!targetId) return
    const win = registry.forSession(targetId)
    if (selectionDeliveries.has(targetId)) {
      win?.webContents.send('selection:toast', {
        kind: 'Selection not inserted',
        snippet: 'Another selection is still being inserted. Try again.',
      })
      return
    }
    const descriptor = catalog.get(targetId)
    if (!win || !descriptor || deps.isReplacing(targetId)) {
      win?.webContents.send('selection:toast', {
        kind: 'Session changing',
        snippet: 'Selection was not inserted while the terminal was being replaced.',
      })
      return
    }
    const request = deliverSelectionToSession(
      records,
      {
        isCurrent: () =>
          !deps.isQuitting() &&
          !win.isDestroyed() &&
          registry.forSession(targetId) === win &&
          catalog.get(targetId)?.generation === descriptor.generation,
        inject: async (text) => {
          await deps.tether.inject(targetId, descriptor.generation, text, 'type')
        },
        delivered: (usable) => {
          win.show()
          win.focus()
          const head = usable[0]
          win.webContents.send('selection:toast', {
            kind: usable.length > 1 ? `${usable.length} items` : head.kind,
            snippet:
              usable.length > 1 ? usable.map((r) => r.snippet ?? '').join(' · ') : head.snippet,
          })
        },
      },
      (error) => {
        console.warn('[aico] selection insert failed:', error)
        win.webContents.send('selection:toast', {
          kind: 'Selection not inserted',
          snippet:
            error instanceof TetherError && error.code === 'stale_generation'
              ? 'The session changed. Try again.'
              : 'Tether could not insert the selection.',
        })
      },
    )
    selectionDeliveries.set(targetId, request)
    void request.finally(() => {
      if (selectionDeliveries.get(targetId) === request) selectionDeliveries.delete(targetId)
    })
  }

  // "Indicate" hotkey (X11 fallback for non-web sources): harvest the freshest
  // capture from the bus and deliver it. Browser sends arrive via SSE instead.
  async function selectionGrab(): Promise<void> {
    if (!sidecar?.ready) return // never take text from a process we did not start
    try {
      const res = await fetchImpl(`http://${deps.host}:${deps.port}/selection/current`)
      if (!res.ok) return
      deliverSelection([(await res.json()) as SelectionRecord])
    } catch {
      // sidecar unreachable — best-effort
    }
  }

  // Run a desktop grab from a click (the menu rows). The same `scripts/aico-grab.sh`
  // the global hotkeys fire, but invoked deliberately: clicking a window grab passes
  // `-p` so the user picks the target window (the focused window is Aico's menu, so a
  // bare focused-window grab would only ever shoot Aico), and a region grab passes
  // `-r`. Env mirrors the hotkey install: keep a usable DISPLAY fallback and
  // prepend common user bin dirs where optional capture tools may live.
  // Resolve a bundled `scripts/` file to a real on-disk path bash can exec. When
  // packaged, scripts/ is asar-unpacked (a script inside app.asar can't be run by
  // a child process), so point at the unpacked mirror under resources.
  function scriptsRoot(): string {
    return app.isPackaged ? join(deps.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
  }

  function runDesktopGrab(args: string[]): void {
    const script = join(scriptsRoot(), 'scripts', 'aico-grab.sh')
    const home = deps.home
    const env = {
      ...deps.env,
      DISPLAY: deps.env.DISPLAY || ':0',
      PATH: `${home}/bin:${home}/.local/bin:/usr/local/bin:${deps.env.PATH ?? ''}`,
    }
    execFile('bash', [script, ...args], { env }, (err) => {
      if (err) console.warn('[aico] desktop grab failed:', err.message)
    })
  }

  function subscribeSelectionEvents(): void {
    selectionEvents = new AbortController()
    const url = `http://${deps.host}:${deps.port}/selection/events`
    void (async () => {
      while (!deps.isQuitting()) {
        const connection = new AbortController()
        const stopConnection = () => connection.abort()
        selectionEvents?.signal.addEventListener('abort', stopConnection)
        let idle: NodeJS.Timeout | undefined
        const armIdle = () => {
          clearTimeout(idle)
          idle = setTimeout(stopConnection, SELECTION_EVENTS_IDLE_MS)
        }
        try {
          if (!sidecar?.ready) throw new Error('sidecar not ready')
          armIdle()
          const res = await fetchImpl(url, { signal: connection.signal })
          if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            armIdle()
            buf += decoder.decode(value, { stream: true })
            const { events, rest } = parseSse(buf)
            buf = rest
            for (const data of events) {
              try {
                const payload = JSON.parse(data) as { records?: SelectionRecord[] }
                if (payload.records?.length) deliverSelection(payload.records)
              } catch {
                // malformed frame — skip
              }
            }
          }
        } catch {
          if (deps.isQuitting() || selectionEvents?.signal.aborted) return
        } finally {
          clearTimeout(idle)
          selectionEvents?.signal.removeEventListener('abort', stopConnection)
        }
        await new Promise((r) => setTimeout(r, 1000)) // backoff before reconnect
      }
    })()
  }

  function startSidecar(): void {
    // Packaged: spawn the bundled PyInstaller executable from resources (no Python
    // needed). Dev: `app.getAppPath()` is the repo root, so resolvePython finds the
    // .venv and runs `-m aico_sidecar`. The packaged spawn cwd is a real directory
    // (resourcesPath) since app.asar isn't a chdir-able path.
    const packaged = app.isPackaged
    const repoRoot = packaged ? deps.resourcesPath : app.getAppPath()
    const command = packaged ? bundledSidecar(deps.resourcesPath) : undefined
    const args = packaged ? [] : undefined
    sidecar = new SidecarCtor(
      {
        host: deps.host,
        port: deps.port,
        repoRoot,
        stateDir: deps.stateDir,
        command,
        args,
      },
      (status, detail) => console.log(`[aico] sidecar ${status}${detail ? `: ${detail}` : ''}`),
    )
    // Fire-and-forget: widgets render against tmux without the sidecar, so don't
    // gate the UI on it; the health result is logged via onStatus.
    sidecar.start().catch((err) => console.warn('[aico] sidecar start failed:', err))
  }

  return {
    startSidecar,
    /** Browser-driven sends (and any CLI POST to /selection/send) arrive here. */
    subscribe: subscribeSelectionEvents,
    /** The indicate hotkey's harvest. */
    grab: selectionGrab,
    /** The session an indicated selection (or a voice toggle) goes to. */
    target: selectionTarget,
    /** A window gained focus; a window with no session keeps the last target. */
    noteFocus: (sessionId: string | undefined): void => {
      lastFocusedAico = sessionId ?? lastFocusedAico
    },
    /** The per-widget event log (the sidecar's JSONL). */
    logEvent: logWidgetEvent,
    /** Quit: stop the deliver-event stream, then the sidecar. Safe if never started. */
    stop: (): void => {
      selectionEvents?.abort()
      sidecar?.stop()
    },
    registerIpc: (ipcMain: Pick<IpcMain, 'on'>): void => {
      ipcMain.on('selection:grab', () => void selectionGrab())
      // Desktop grab fired from a menu click (window pick / region drag). Args are the
      // aico-grab.sh flags chosen by the renderer; validated to a small allowlist.
      ipcMain.on('grab:run', (_event, args: string[]) => {
        const allowed = new Set(['-p', '-t', '-r'])
        if (Array.isArray(args) && args.every((a) => allowed.has(a))) runDesktopGrab(args)
      })
    },
  }
}
