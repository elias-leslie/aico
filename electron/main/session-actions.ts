// Session actions: what the owner can do to a session (End, rename, switch its
// tool or workspace, mark it coordinator, open one) and the renderer and tray
// entry points for them. Every action goes through Tether; the catalog and the
// titlebars follow from what Tether answers.

import type { IpcMain } from 'electron'
import {
  OWNER_CHECK_IN_NOTE,
  type SessionCatalog,
  type SessionDescriptor,
  type TetherClient,
  TetherError,
  type TetherTool,
  wakeChoices,
  wakeClock,
} from 'tether/client'
import { CHAT_TOOL } from './chat-launch'
import { type InstructionsChoice, parseChoice } from './instructions'
import { describeFailure, writeNotice } from './notices'
import { PERSONAL_WORKSPACE_ID, type ProjectCatalog } from './project'
import { sessionTitle, toolDisplayName, traySessionLabel } from './session-catalog'
import { toolMark } from './tool-marks'
import type { WindowRegistry } from './window-registry'

const SESSION_ID = /^[0-9a-f]{8}$/
const WAKE_ID = /^[0-9a-f]{12}$/

/** What the window menu's "Check in later" shows. */
export interface CheckInMenu {
  status: 'ready' | 'unsupported' | 'unavailable'
  choices: { label: string; time: string; dueAt: number }[]
  pending: { id: string; time: string }[]
}

/** Tether's refusals of a check-in, worded for the owner. */
const CHECK_IN_REFUSALS: Record<string, string> = {
  wake_unsupported: "Aico can't tell when this session is idle, so it can't take check-ins",
  too_many_wakes: 'This session has as many check-ins as it can take',
}

/** `5:30 PM` or `5:30 PM and Tue 9:00 AM`. */
function timesLabel(times: string[]): string {
  return times.length > 1
    ? `${times.slice(0, -1).join(', ')} and ${times.at(-1)}`
    : (times[0] ?? '')
}

/** A hosts.json host name, as the hub names it. */
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
interface SessionActionsDeps {
  tether: Pick<
    TetherClient,
    | 'getSession'
    | 'end'
    | 'setCoordinator'
    | 'loadTui'
    | 'switchProject'
    | 'rename'
    | 'diagnostics'
    | 'sessionWakes'
    | 'addWake'
    | 'cancelWake'
    | 'hosts'
    | 'projects'
  >
  catalog: Pick<SessionCatalog, 'get' | 'upsert' | 'list'>
  link: {
    tools(): TetherTool[]
    refresh(): Promise<void>
    requestRefresh(): void
    refreshTools(): Promise<void>
    sessionEnded(id: string, reason: string): void
  }
  registry: Pick<WindowRegistry, 'forSession' | 'senderSession'>
  windows: {
    openNew(
      tool: string,
      projectId: string,
      instructions?: InstructionsChoice,
      host?: string,
    ): unknown
    showAll(): void
    focusOrReopen(id: string): void
  }
  projects: Pick<ProjectCatalog, 'listFresh' | 'nameFor'>
  titles(): void
  tray(): void
  dialog: {
    showMessageBox(options: Electron.MessageBoxOptions): Promise<{ response: number }>
  }
  personalWorkspace: {
    /** The Personal Workspace directory, created if missing; null when it cannot be. */
    ensureRoot(): string | null
    root(): string
  }
}

export function createSessionActions(deps: SessionActionsDeps) {
  const { tether, catalog, link, registry, windows, projects, dialog } = deps
  // Sessions whose pane is being replaced (load-TUI, switch-project). Renderer
  // input is dropped meanwhile, as before: the pane briefly shows Tether's
  // containment gate and stale keystrokes must never reach it.
  const replacing = new Set<string>()
  const endsInFlight = new Map<string, Promise<void>>()

  /** Ask Tether to mark or unmark a coordinator; the change comes back as
   * `session.updated`. */
  function requestCoordinator(id: string, coordinator: boolean): void {
    const descriptor = catalog.get(id)
    if (!descriptor) return
    tether.setCoordinator(id, descriptor.generation, coordinator).catch((error) => {
      writeNotice(
        registry.forSession(id),
        describeFailure('Could not change the coordinator mark', error),
        33,
      )
    })
  }

  /** End a session: re-read its exact generation, then ask Tether to End it.
   * Repeat requests for the same session share one attempt. */
  function endSession(id: string, options: { keepWakes?: boolean } = {}): Promise<void> {
    const current = endsInFlight.get(id)
    if (current) return current
    const attempt = (async () => {
      let descriptor: SessionDescriptor
      try {
        descriptor = await tether.getSession(id)
      } catch (error) {
        if (error instanceof TetherError && error.code === 'not_found') {
          link.sessionEnded(id, 'absent')
          return
        }
        throw error
      }
      try {
        await tether.end(id, descriptor.generation, options)
      } catch (error) {
        if (error instanceof TetherError && error.code === 'not_found') {
          link.sessionEnded(id, 'absent')
          return
        }
        throw error
      }
      link.sessionEnded(id, 'ended')
    })().finally(() => endsInFlight.delete(id))
    endsInFlight.set(id, attempt)
    return attempt
  }

  function discardWidget(id: string, options: { keepWakes?: boolean } = {}): void {
    void endSession(id, options).catch((error) => {
      console.error(`[aico] End failed widget=${id}:`, error)
      writeNotice(registry.forSession(id), describeFailure('End failed', error))
    })
  }

  /** Ask before an End. A session with check-ins says End cancels them and
   * offers to keep them instead. */
  async function askEnd(id: string): Promise<'cancel' | 'end' | 'keep'> {
    const descriptor = catalog.get(id)
    if (!descriptor) return 'cancel'
    const message = `End ${traySessionLabel(sessionTitle(descriptor), toolDisplayName(descriptor.tool, link.tools()))}?`
    const wakes = descriptor.wakes ?? []
    if (!wakes.length) {
      const response = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Cancel', 'End session'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'End session?',
        message,
        detail: 'Tether stops only this session’s verified workload. This cannot be undone.',
      })
      return response.response === 1 ? 'end' : 'cancel'
    }
    const several = wakes.length > 1
    const response = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', several ? 'End, keep check-ins' : 'End, keep check-in', 'End session'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'End session?',
      message,
      detail: `This also cancels its check-in${several ? 's' : ''} at ${timesLabel(wakes.map((wake) => wakeClock(wake.dueAt)))}. Keep ${several ? 'them' : 'it'}, and the conversation comes back in a new session then.`,
    })
    return response.response === 2 ? 'end' : response.response === 1 ? 'keep' : 'cancel'
  }

  async function confirmTrayDiscard(id: string): Promise<void> {
    const choice = await askEnd(id)
    if (choice !== 'cancel') discardWidget(id, { keepWakes: choice === 'keep' })
  }

  async function checkInMenu(id: string): Promise<CheckInMenu> {
    try {
      const { items, policy } = await tether.sessionWakes(id)
      const now = Date.now()
      const state = catalog.get(id)?.state
      return {
        // Tether wakes only agent sessions whose idle state it can read.
        status: state && state !== 'unknown' ? 'ready' : 'unsupported',
        choices: wakeChoices(policy, now).map((choice) => ({
          ...choice,
          time: wakeClock(choice.dueAt, now),
        })),
        pending: items.map((wake) => ({
          id: wake.id,
          time: wakeClock(wake.dueAt, now),
          due: wake.dueAt <= now,
        })),
      }
    } catch {
      return { status: 'unavailable', choices: [], pending: [] }
    }
  }

  /** Set an owner check-in; answers its time, or throws the owner's wording. */
  async function checkInLater(id: string, dueAt: number): Promise<string> {
    try {
      const wake = await tether.addWake(id, {
        dueAt,
        note: OWNER_CHECK_IN_NOTE,
        createdBy: 'owner',
      })
      return wakeClock(wake.dueAt)
    } catch (error) {
      const refusal = error instanceof TetherError ? CHECK_IN_REFUSALS[error.code] : undefined
      throw new Error(refusal ?? describeFailure('Could not set the check-in', error))
    }
  }

  async function cancelCheckIn(wakeId: string): Promise<void> {
    try {
      await tether.cancelWake(wakeId)
    } catch (error) {
      if (!(error instanceof TetherError && error.code === 'not_found')) {
        console.warn(`[aico] could not cancel check-in ${wakeId}:`, error)
        throw new Error(describeFailure('Could not cancel the check-in', error))
      }
    } finally {
      link.requestRefresh()
    }
  }

  /** Run a pane replacement with the generation Aico last read. Input is held
   * back until it settles; failures are shown in the session's terminal. */
  function replacePane(
    id: string,
    action: string,
    run: (generation: string) => Promise<SessionDescriptor>,
  ): void {
    const descriptor = catalog.get(id)
    if (!descriptor || replacing.has(id)) return
    replacing.add(id)
    void run(descriptor.generation)
      .then((next) => catalog.upsert(next))
      .catch((error) => {
        console.warn(`[aico] ${action} failed widget=${id}:`, error)
        writeNotice(registry.forSession(id), describeFailure(action, error))
        link.requestRefresh()
      })
      .finally(() => {
        replacing.delete(id)
        deps.titles()
        deps.tray()
      })
  }

  function loadTui(id: string, slug: string): void {
    replacePane(id, 'Could not switch the tool', (generation) =>
      tether.loadTui(id, generation, slug),
    )
  }

  function switchProject(id: string, projectId: string): void {
    if (projectId === PERSONAL_WORKSPACE_ID) {
      // A directory, not a project: Tether switches to it by root.
      const root = deps.personalWorkspace.ensureRoot()
      if (!root) {
        writeNotice(
          registry.forSession(id),
          `Could not switch the workspace: ${deps.personalWorkspace.root()} could not be created.`,
          33,
        )
        return
      }
      replacePane(id, 'Could not switch the workspace', (generation) =>
        tether.switchProject(id, generation, { projectRoot: root }),
      )
      return
    }
    replacePane(id, 'Could not switch the workspace', (generation) =>
      tether.switchProject(id, generation, { projectId }),
    )
  }

  async function renameSession(id: string, name: unknown): Promise<void> {
    const descriptor = catalog.get(id)
    if (!descriptor) return
    const trimmed = typeof name === 'string' ? name.trim() : ''
    try {
      catalog.upsert(await tether.rename(id, descriptor.generation, trimmed || null))
    } catch (error) {
      writeNotice(registry.forSession(id), describeFailure('Could not rename', error), 33)
    }
    deps.titles()
    deps.tray()
  }

  function registerIpc(ipcMain: Pick<IpcMain, 'on' | 'handle'>): void {
    ipcMain.handle('session:diagnostics', async (event) => {
      const widgetId = registry.senderSession(event.sender)
      if (!widgetId) return { capturedAt: new Date().toISOString(), error: 'no session' }
      try {
        return await tether.diagnostics(widgetId)
      } catch (error) {
        return {
          capturedAt: new Date().toISOString(),
          sessionId: widgetId,
          error: describeFailure('Diagnostics unavailable', error),
        }
      }
    })

    // Control-surface actions: same handlers the tray uses. A new session is
    // always an explicit (tool, workspace) pair from the picker — both required,
    // both checked (untrusted renderer input), so a malformed call is ignored.
    // Chosen instructions are optional; malformed ones refuse the launch.
    ipcMain.on(
      'widget:new',
      (_event, tool?: unknown, projectId?: unknown, instructions?: unknown, host?: unknown) => {
        const choice = instructions == null ? undefined : parseChoice(instructions)
        if (choice === null) return
        if (host != null && (typeof host !== 'string' || !HOST_NAME.test(host))) return
        if (typeof tool === 'string' && tool && typeof projectId === 'string' && projectId) {
          if (host) windows.openNew(tool, projectId, choice, host)
          else if (choice) windows.openNew(tool, projectId, choice)
          else windows.openNew(tool, projectId)
        }
      },
    )
    // The remote hosts a new session can run on, as the hub lists them.
    ipcMain.handle('hosts:list', async () => {
      try {
        const items = (await tether.hosts()).map((h) => ({ name: h.name, state: h.state }))
        return { status: 'ready', items }
      } catch {
        return { status: 'unavailable', items: [] }
      }
    })
    // A remote host's projects, for a session started there.
    ipcMain.handle('hosts:projects', async (_event, host?: unknown) => {
      if (typeof host !== 'string' || !HOST_NAME.test(host))
        return { status: 'unavailable', items: [] }
      try {
        const items = (await tether.projects(false, host)).map((p) => ({
          id: p.id,
          name: p.name,
          current: false,
        }))
        return { status: 'ready', items }
      } catch {
        return { status: 'unavailable', items: [] }
      }
    })
    ipcMain.on('widget:hub', windows.showAll)

    // End this session from the widget itself: Tether ends the workload and the
    // window closes once it has.
    ipcMain.handle('session:end-self', async (event) => {
      const id = registry.senderSession(event.sender)
      if (!id) throw new Error('Session view is unavailable')
      // The menu already asked once; a session with check-ins asks which End.
      let keepWakes = false
      if (catalog.get(id)?.wakes?.length) {
        const choice = await askEnd(id)
        if (choice === 'cancel') return
        keepWakes = choice === 'keep'
      }
      try {
        await endSession(id, { keepWakes })
      } catch (error) {
        throw new Error(describeFailure('End failed', error))
      }
    })

    ipcMain.handle('session:check-in-menu', async (event): Promise<CheckInMenu> => {
      const id = registry.senderSession(event.sender)
      return id ? checkInMenu(id) : { status: 'unavailable', choices: [], pending: [] }
    })
    ipcMain.handle('session:check-in', async (event, dueAt: unknown) => {
      const id = registry.senderSession(event.sender)
      if (!id || typeof dueAt !== 'number' || !Number.isSafeInteger(dueAt))
        throw new Error('Could not set the check-in')
      return checkInLater(id, dueAt)
    })
    // Only this window's own session's check-ins.
    ipcMain.handle('session:cancel-check-in', async (event, wakeId: unknown) => {
      const id = registry.senderSession(event.sender)
      if (!id || typeof wakeId !== 'string' || !WAKE_ID.test(wakeId)) return
      if (!catalog.get(id)?.wakes?.some((wake) => wake.id === wakeId)) return
      await cancelCheckIn(wakeId)
    })

    ipcMain.on('widget:toggle-coordinator', (event) => {
      const id = registry.senderSession(event.sender)
      if (id) requestCoordinator(id, !catalog.get(id)?.coordinator)
    })

    // Replace the focused session's running tool with another (no new window).
    ipcMain.on('widget:load-tui', (event, slug?: unknown) => {
      const id = registry.senderSession(event.sender)
      if (id && typeof slug === 'string' && slug) loadTui(id, slug)
    })

    // Move the focused session to another workspace: Tether respawns its pane
    // there with the same tool.
    ipcMain.on('widget:switch-project', (event, projectId?: unknown) => {
      const id = registry.senderSession(event.sender)
      if (id && typeof projectId === 'string' && projectId) switchProject(id, projectId)
    })

    // Rename from the titlebar. Empty clears it back to Tether's default label.
    ipcMain.on('widget:set-name', (event, name: unknown) => {
      const id = registry.senderSession(event.sender)
      if (id) void renameSession(id, name)
    })

    // Enabled tools from Tether's registry, in its order, with Aico's marks.
    ipcMain.handle('tui:list', async () => {
      if (!link.tools().length) await link.refreshTools().catch(() => {})
      return link.tools().map((tool) => {
        const mark = toolMark(tool.slug, tool.color)
        return {
          slug: tool.slug,
          displayName: tool.name,
          accent: mark.accent,
          icon: mark.icon,
          blankSlate: tool.blankSlate === true,
          instructions: tool.instructions === true,
          chat: tool.slug === CHAT_TOOL,
        }
      })
    })

    // Workspace catalog for "Open workspace ▸": Personal Workspace plus Tether's
    // projects. Awaits a stale refresh so the first menu is complete.
    ipcMain.handle('project:list', () => projects.listFresh())

    // Every running Tether session, whichever app created it.
    ipcMain.handle('session:list-openable', async () => {
      await link.refresh()
      return catalog
        .list()
        .filter((descriptor) => descriptor.status === 'running')
        .map((descriptor) => ({
          id: descriptor.id,
          origin: descriptor.origin,
          label: sessionTitle(descriptor),
          project: projects.nameFor(descriptor.projectId, descriptor.projectRoot),
          tool: toolDisplayName(descriptor.tool, link.tools()),
          status: 'running' as const,
          locallyOpen: Boolean(registry.forSession(descriptor.id)),
        }))
    })
    ipcMain.handle('session:open', async (_event, id: unknown) => {
      if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error('Invalid session')
      const descriptor = await tether.getSession(id)
      if (descriptor.status !== 'running') throw new Error('Session is unavailable')
      catalog.upsert(descriptor)
      windows.focusOrReopen(id)
    })
  }

  return {
    /** End a session through Tether; concurrent calls for one session share one attempt. */
    end: endSession,
    /** The tray's End: ask first, then End; a failure shows in the session's terminal. */
    confirmTrayDiscard,
    /** The tray's Cancel on a check-in. */
    cancelCheckIn: (wakeId: string): void => void cancelCheckIn(wakeId).catch(() => {}),
    requestCoordinator,
    /** Tether is replacing this session's pane: renderer input and deliveries wait. */
    isReplacing: (id: string): boolean => replacing.has(id),
    registerIpc,
  }
}
