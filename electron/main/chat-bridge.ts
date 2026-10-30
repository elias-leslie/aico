// The native chat window's half in main: a window showing an Agent Hub session
// (Tether's `agent-hub` kind) draws the shared chat component instead of a
// terminal, and all of its I/O comes through here.
//
// Why main and Tether, not the renderer: Agent Hub is called by Tether, the one
// process that reads the owner token (per request, from its file) and knows the
// session's Agent Hub id and follow-up queue. Main only asks Tether, over its
// private socket, for the window's own session, so no token, Agent Hub address
// or Agent Hub id of another session ever reaches the renderer. The renderer
// names no session: main answers for the session the sender's window shows.
//
// Channels (preload `window.aico.chat`):
//   chat:info         invoke -> {sessionId, agentSlug, requestedModel, branch?} or null
//   chat:call         invoke (method, args) -> {ok, value} | {ok: false, error}
//   chat:stream-open  invoke (afterSeq) -> stream id; events arrive as chat:event
//   chat:stream-close send   (stream id)
//   chat:event        main -> renderer (stream id, item)

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import type { SessionCatalog, SessionDescriptor } from 'tether/client'
import {
  afterSeqOf,
  CHAT_METHODS,
  ChatRefusal,
  type ChatTarget,
  type ChatTether,
  chatCall,
  failure,
  followChat,
  gitBranch,
  sessionTarget,
  stepTarget,
} from '../../shared/chat/forward'
import type { ChatCallResult, ChatFailure, ChatInfo, ChatStreamItem } from '../../shared/chat/types'
import type { WindowRegistry } from './window-registry'

export { gitBranch, MAX_CHAT_TEXT } from '../../shared/chat/forward'

const MAX_STREAMS_PER_WINDOW = 4

interface ChatBridgeDeps {
  /** The branch of a folder, for the status line. Default reads the folder's git files. */
  branchOf?: (root: string | null) => string | null
  tether: ChatTether
  catalog: Pick<SessionCatalog, 'get'>
  registry: Pick<WindowRegistry, 'senderSession' | 'senderViewer'>
}

export function createChatBridge(deps: ChatBridgeDeps) {
  const { tether, catalog, registry } = deps
  const branchOf = deps.branchOf ?? gitBranch
  let nextStream = 1
  // webContents id -> stream id -> abort
  const streams = new Map<number, Map<string, AbortController>>()

  // webContents id -> the attempt session its window opened on. A retry makes a new
  // attempt; the window stays on the one it opened with.
  const stepTargets = new Map<number, ChatTarget>()

  /** What the sender's window reads, if it is an Agent Hub chat or a step reader. */
  async function chatSession(sender: WebContents): Promise<ChatTarget | null> {
    const viewer = registry.senderViewer(sender)
    if (viewer) {
      let target = stepTargets.get(sender.id)
      if (!target) {
        try {
          target = await stepTarget(tether, viewer.runId, viewer.stepKey)
          stepTargets.set(sender.id, target)
          sender.once('destroyed', () => stepTargets.delete(sender.id))
        } catch {
          return null
        }
      }
      return target
    }
    const id = registry.senderSession(sender)
    if (!id) return null
    let descriptor = catalog.get(id)
    if (!descriptor) {
      // The catalog may not have it yet (a window restored before the first
      // list): ask Tether once.
      try {
        descriptor = (
          await tether.request<SessionDescriptor>('GET', `/v1/sessions/${encodeURIComponent(id)}`)
        ).body
      } catch {
        return null
      }
    }
    return sessionTarget(descriptor, branchOf(descriptor.projectRoot))
  }

  async function call(
    sender: WebContents,
    method: unknown,
    args: unknown,
  ): Promise<ChatCallResult> {
    try {
      if (typeof method !== 'string' || !CHAT_METHODS.has(method))
        throw new ChatRefusal('unknown_method', 'Unknown chat request.')
      const target = await chatSession(sender)
      if (!target) throw new ChatRefusal('not_a_chat', 'This window is not an Agent Hub chat.')
      // The current descriptor (its generation moves), else the one the window opened with.
      const current = target.kind === 'session' ? catalog.get(target.descriptor.id) : undefined
      return await chatCall(tether, target, current ?? null, method, args)
    } catch (error) {
      return { ok: false, error: failure(error) }
    }
  }

  function forgetStream(senderId: number, streamId: string): void {
    const owned = streams.get(senderId)
    owned?.get(streamId)?.abort()
    owned?.delete(streamId)
    if (owned?.size === 0) streams.delete(senderId)
  }

  async function open(webContents: WebContents, afterSeq: unknown): Promise<string | ChatFailure> {
    const target = await chatSession(webContents)
    if (!target)
      return failure(new ChatRefusal('not_a_chat', 'This window is not an Agent Hub chat.'))
    const after = afterSeqOf(afterSeq)
    const owned = streams.get(webContents.id) ?? new Map<string, AbortController>()
    if (owned.size >= MAX_STREAMS_PER_WINDOW)
      return failure(new ChatRefusal('too_many_streams', 'Too many chat streams are open.'))
    if (owned.size === 0) {
      streams.set(webContents.id, owned)
      webContents.once('destroyed', () => {
        for (const controller of streams.get(webContents.id)?.values() ?? []) controller.abort()
        streams.delete(webContents.id)
      })
    }
    const streamId = `s${nextStream++}`
    const controller = new AbortController()
    owned.set(streamId, controller)
    const push = (item: ChatStreamItem): void => {
      if (!webContents.isDestroyed() && !controller.signal.aborted)
        webContents.send('chat:event', streamId, item)
    }
    void followChat(tether, target, after, controller.signal, push).finally(() =>
      forgetStream(webContents.id, streamId),
    )
    return streamId
  }

  const info = async (sender: WebContents): Promise<ChatInfo | null> =>
    (await chatSession(sender))?.info ?? null

  return {
    info,
    call,
    open,
    close: (senderId: number, streamId: string): void => forgetStream(senderId, streamId),
    /** Streams currently open, for tests. */
    openStreams: (): number => [...streams.values()].reduce((sum, owned) => sum + owned.size, 0),

    registerIpc: (ipcMain: Pick<IpcMain, 'on' | 'handle'>): void => {
      ipcMain.handle('chat:info', (event: IpcMainInvokeEvent) => info(event.sender))
      ipcMain.handle('chat:call', (event: IpcMainInvokeEvent, method: unknown, args: unknown) =>
        call(event.sender, method, args),
      )
      ipcMain.handle('chat:stream-open', (event: IpcMainInvokeEvent, afterSeq: unknown) =>
        open(event.sender, afterSeq),
      )
      ipcMain.on('chat:stream-close', (event: IpcMainEvent, streamId: unknown) => {
        if (typeof streamId === 'string') forgetStream(event.sender.id, streamId)
      })
    },
  }
}
