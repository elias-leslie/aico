// The live connection to Tether and Aico's mirror of its sessions and tools.
// Tether owns every session; this keeps the catalog current from its event
// stream and complete lists, holds the GUI channel, and tells the rest of Aico
// what changed through hooks, called in the order the root relies on.

import type { ProjectCatalog } from './project'
import type { SessionCatalog } from './session-catalog'
import {
  compatibleVersion,
  eventSession,
  followEvents,
  type GuiCommand,
  type GuiVerdict,
  holdGuiChannel,
  type SessionDescriptor,
  type TetherClient,
  type TetherEvent,
  type TetherTool,
  TetherUnavailable,
} from './tether-client'
import { coalesceAsync } from './tmux-view'

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
  /** The event stream came back after being down (or connected the first time). */
  connected(): void
}

interface TetherLinkDeps {
  tether: TetherClient
  catalog: SessionCatalog
  projects: Pick<ProjectCatalog, 'invalidate' | 'refresh'>
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

  function onTetherEvent(event: TetherEvent): void {
    const id = typeof event.data.id === 'string' ? event.data.id : null
    switch (event.type) {
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
      case 'root.updated':
        requestSessionRefresh()
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
      `${tetherIncompatible}. Your sessions keep running. Install a current Tether (scripts/install.sh in the Tether repo) and restart Aico.`,
    )
  }

  function connectTether(applyGuiCommand: (command: GuiCommand) => Promise<GuiVerdict>): void {
    stopEvents = followEvents(tether, {
      onConnected: () => {
        const reconnected = !tetherConnected
        tetherConnected = true
        if (reconnected) {
          console.log(`[aico:tether] connected at ${tether.socketPath}`)
          void checkTetherVersion()
          void refreshTools().catch(() => {})
          void projects.refresh()
          hooks.connected()
        }
      },
      onDisconnected: (error) => {
        if (tetherConnected) console.warn('[aico:tether] event stream lost:', error)
        tetherConnected = false
        hooks.tray()
      },
      onResync: requestSessionRefresh,
      onEvent: onTetherEvent,
    })
    stopGuiChannel = holdGuiChannel(tether, applyGuiCommand, (message, error) =>
      error === undefined
        ? console.log(`[aico:gui] ${message}`)
        : console.warn(`[aico:gui] ${message}:`, error instanceof Error ? error.message : error),
    )
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
