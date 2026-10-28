// The live connection to Tether and Aico's mirror of its sessions and tools.
// Tether owns every session; this keeps the catalog current from its event
// stream and complete lists, holds the GUI channel, and tells the rest of Aico
// what changed through hooks, called in the order the root relies on.

import type { SessionCatalog } from './catalog'
import { followEvents, holdGuiChannel, type TetherClient } from './client'
import {
  compatibleVersion,
  eventSession,
  type GuiCommand,
  type GuiVerdict,
  type RunsAnswer,
  type SessionDescriptor,
  type TetherEvent,
  type TetherTool,
  TetherUnavailable,
  type ViewerLabel,
} from './contracts'

/** The holder's label from a `session.resized` event (Tether checked it on the claim). */
function viewerOf(value: unknown): ViewerLabel | null {
  const label = value as Partial<ViewerLabel> | null
  return label && typeof label.app === 'string' && typeof label.device === 'string'
    ? { app: label.app, device: label.device }
    : null
}

/** Share one pending query without retaining a stale result. */
export function coalesceAsync<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    if (pending) return pending
    const request = Promise.resolve().then(load)
    pending = request
    const clear = () => {
      if (pending === request) pending = undefined
    }
    void request.then(clear, clear)
    return request
  }
}

interface LinkHooks {
  /** A session's agent state as Tether last reported it. */
  agentState(descriptor: SessionDescriptor): void
  /** A session left the catalog. */
  removed(id: string): void
  /** A complete list no longer has this session: close its window, keep its view row. */
  destroyWindow(id: string): void
  /** Tether ended this session: close its window. */
  closeEnded(id: string): void
  /** The session is gone for good: forget its view row. */
  retired(id: string): void
  /** The first complete list after start. */
  firstList(): void
  titles(): void
  tray(): void
  /** The workflow runs of the sessions changed (or were read again). */
  runs(answer: RunsAnswer): void
  /** The event stream came back after being down (or connected the first time). */
  connected(): void
  /** A handoff received from the agent's socket only; payload is still untrusted. */
  shared(data: Record<string, unknown>): void
  /** A client claimed this session's shared window size; `viewer` names its
   * app and device (null when the claimer sent none). */
  sizeHeld(id: string, clientPid: number, viewer: ViewerLabel | null): void
}

interface TetherLinkDeps {
  tether: TetherClient
  shareSocket: string
  catalog: SessionCatalog
  projects: { invalidate(): void; refresh(): Promise<unknown> }
  dialog: { showErrorBox(title: string, content: string): void }
  hooks: LinkHooks
}

/** One ids-only journal line per retired session Aico knew: no titles, no paths. */
function retiredEventLine(id: string, sessionId: string, reason: string): string {
  return `[aico:event] lifecycle_retired widget=${id} session=${sessionId} reason=${reason}`
}

export function createTetherLink(deps: TetherLinkDeps) {
  const { tether, catalog, projects, dialog, hooks } = deps
  let tetherConnected = false
  let tetherIncompatible: string | null = null
  let tools: TetherTool[] = []
  let restored = false
  let stopEvents: (() => void) | null = null
  let stopGuiChannel: (() => void) | null = null
  /** Other instances (the agent's, or the owner's when that is not active) that answered. */
  const otherConnected = new Set<string>()

  const refreshSessions = coalesceAsync(async () => {
    const mark = catalog.mark()
    const list = await tether.listSessions()
    const { gone } = catalog.replace(list, mark)
    for (const id of gone) hooks.removed(id)
    for (const descriptor of catalog.list()) hooks.agentState(descriptor)
    // A view whose session is absent from a complete list is closed but its row
    // is kept: only an explicit `session.ended` forgets a view. A wrong or empty
    // instance must never erase every saved window position.
    for (const id of gone) hooks.destroyWindow(id)
    if (!restored) {
      restored = true
      hooks.firstList()
    }
    hooks.titles()
    hooks.tray()
  })

  function requestSessionRefresh(): void {
    void refreshSessions().catch((error) => {
      if (!(error instanceof TetherUnavailable))
        console.warn('[aico] session refresh failed:', error)
    })
  }

  /** The workflow runs, as Tether last listed them. */
  let runsAnswer: RunsAnswer | null = null
  const refreshRuns = coalesceAsync(async () => {
    runsAnswer = await tether.runs()
    hooks.runs(runsAnswer)
  })
  function requestRunsRefresh(): void {
    void refreshRuns().catch((error) => {
      if (!(error instanceof TetherUnavailable)) console.warn('[aico] runs refresh failed:', error)
    })
  }

  const refreshTools = coalesceAsync(async () => {
    tools = (await tether.tools()).items
      .filter((tool) => tool.enabled)
      .sort((a, b) => a.displayOrder - b.displayOrder)
    hooks.titles()
    hooks.tray()
  })

  function sessionEnded(id: string, reason: string): void {
    const known = catalog.get(id)
    catalog.remove(id)
    hooks.removed(id)
    hooks.closeEnded(id)
    hooks.retired(id)
    if (known) console.log(retiredEventLine(id, known.ownershipId, reason))
    hooks.tray()
  }

  function onTetherEvent(event: TetherEvent, socketPath: string): void {
    const id = typeof event.data.id === 'string' ? event.data.id : null
    switch (event.type) {
      case 'show.requested':
        if (socketPath === deps.shareSocket) hooks.shared(event.data)
        break
      case 'session.ended':
        if (id) sessionEnded(id, 'tether_event')
        requestSessionRefresh()
        break
      case 'session.created':
      case 'session.updated': {
        // Tether sends the descriptor with the event; an older Tether does not,
        // so fall back to re-listing.
        const snapshot = eventSession(event)
        if (!snapshot) {
          requestSessionRefresh()
          break
        }
        catalog.upsert(snapshot)
        hooks.agentState(snapshot)
        hooks.titles()
        hooks.tray()
        break
      }
      case 'session.resized':
        // An older Tether sends no holder; the window then learns nothing new.
        if (id && Number.isSafeInteger(event.data.clientPid))
          hooks.sizeHeld(id, event.data.clientPid as number, viewerOf(event.data.viewer))
        break
      case 'root.updated':
        requestSessionRefresh()
        break
      case 'runs.changed':
        requestRunsRefresh()
        break
      case 'tools.changed':
        void refreshTools().catch(() => {})
        break
      case 'projects.changed':
        projects.invalidate()
        void projects.refresh()
        break
    }
  }

  async function checkTetherVersion(): Promise<void> {
    try {
      const version = await tether.version()
      if (compatibleVersion(version)) {
        tetherIncompatible = null
        return
      }
      tetherIncompatible = `Tether ${version.version} (API ${version.apiVersion}) is not compatible with this Aico`
    } catch (error) {
      if (error instanceof TetherUnavailable) return
      tetherIncompatible = 'Tether did not report a usable version'
    }
    console.error(`[aico:tether] ${tetherIncompatible}; session control is disabled`)
    stopEvents?.()
    stopGuiChannel?.()
    tetherConnected = false
    hooks.tray()
    dialog.showErrorBox(
      'Update Tether',
      `${tetherIncompatible}. Your sessions keep running. Update Aico (scripts/install.sh) and restart it.`,
    )
  }

  /** Events and the GUI channel of an instance that is not the active one: its
   * sessions join the catalog, and its absence is quiet (the agent's instance may not run). */
  function connectOther(
    client: TetherClient,
    applyGuiCommand: (command: GuiCommand) => Promise<GuiVerdict>,
  ): (() => void)[] {
    const stopFollow = followEvents(client, {
      onConnected: () => {
        if (otherConnected.has(client.socketPath)) return
        otherConnected.add(client.socketPath)
        console.log(`[aico:tether] also connected at ${client.socketPath}`)
        hooks.connected()
      },
      onDisconnected: (error) => {
        if (otherConnected.delete(client.socketPath))
          console.warn(`[aico:tether] event stream lost at ${client.socketPath}:`, error)
      },
      onResync: requestSessionRefresh,
      onEvent: (event) => {
        if (event.type !== 'tools.changed' && event.type !== 'projects.changed')
          onTetherEvent(event, client.socketPath)
      },
    })
    const stopGui = holdGuiChannel(client, applyGuiCommand, (message, error) => {
      if (error === undefined) console.log(`[aico:gui] ${message} (${client.socketPath})`)
    })
    return [stopFollow, stopGui]
  }

  function connectTether(applyGuiCommand: (command: GuiCommand) => Promise<GuiVerdict>): void {
    const [active, ...others] = tether.instances()
    stopEvents = followEvents(active, {
      onConnected: () => {
        const reconnected = !tetherConnected
        tetherConnected = true
        if (reconnected) {
          console.log(`[aico:tether] connected at ${tether.socketPath}`)
          void checkTetherVersion()
          void refreshTools().catch(() => {})
          requestRunsRefresh()
          void projects.refresh()
          hooks.connected()
        }
      },
      onDisconnected: (error) => {
        if (tetherConnected) console.warn('[aico:tether] event stream lost:', error)
        tetherConnected = false
        hooks.tray()
      },
      onResync: () => {
        requestSessionRefresh()
        requestRunsRefresh()
      },
      onEvent: (event) => onTetherEvent(event, active.socketPath),
    })
    const stopActiveGui = holdGuiChannel(active, applyGuiCommand, (message, error) =>
      error === undefined
        ? console.log(`[aico:gui] ${message}`)
        : console.warn(`[aico:gui] ${message}:`, error instanceof Error ? error.message : error),
    )
    const stopOthers = others.flatMap((client) => connectOther(client, applyGuiCommand))
    stopGuiChannel = () => {
      stopActiveGui()
      for (const stop of stopOthers) stop()
    }
  }

  function tetherNotice(): string | null {
    if (tetherIncompatible) return `${tetherIncompatible}. Sessions keep running.`
    return tetherConnected ? null : 'Tether is not reachable. Sessions keep running.'
  }

  return {
    /** Tether's enabled tools, in its order. */
    tools: (): TetherTool[] => tools,
    /** Why session control is unavailable right now, for the tray; null when connected. */
    notice: tetherNotice,
    /** Re-list every session. One list at a time; callers share an in-flight one. */
    refresh: refreshSessions,
    /** `refresh` in the background; an unreachable Tether is not worth a warning. */
    requestRefresh: requestSessionRefresh,
    refreshTools,
    /** The workflow runs as Tether last listed them; null before the first look. */
    runs: (): RunsAnswer | null => runsAnswer,
    refreshRuns,
    /** Tether ended this session (or it is absent): forget it everywhere. */
    sessionEnded,
    /** Follow the event stream and hold the GUI channel, applying its commands with `applyGui`. */
    connect: connectTether,
    /** Stop the event stream and the GUI channel; safe if never connected. */
    stop: (): void => {
      stopEvents?.()
      stopGuiChannel?.()
    },
  }
}
