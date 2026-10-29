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
//   chat:info         invoke -> {sessionId, agentSlug, requestedModel} or null
//   chat:call         invoke (method, args) -> {ok, value} | {ok: false, error}
//   chat:stream-open  invoke (afterSeq) -> stream id; events arrive as chat:event
//   chat:stream-close send   (stream id)
//   chat:event        main -> renderer (stream id, item)

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import {
  type SessionCatalog,
  type SessionDescriptor,
  type TetherClient,
  TetherError,
  TetherUnavailable,
} from 'tether/client'
import type { ChatCallResult, ChatFailure, ChatInfo, ChatStreamItem } from '../types'
import type { WindowRegistry } from './window-registry'

/** A follow-up is typed text; this is the same bound Tether's inject route holds. */
export const MAX_CHAT_TEXT = 60_000
/** Tether's bound on a model id. */
const MAX_MODEL_ID = 128
const MAX_STREAMS_PER_WINDOW = 4
const METHODS: ReadonlySet<string> = new Set(['session', 'queue', 'send', 'cancel', 'models'])

interface ChatBridgeDeps {
  tether: Pick<TetherClient, 'request' | 'stream'>
  catalog: Pick<SessionCatalog, 'get'>
  registry: Pick<WindowRegistry, 'senderSession'>
}

/** The words the owner sees for a failure; never a token, address or stack. */
function failure(error: unknown): ChatFailure {
  if (error instanceof TetherError) {
    const agentHubDown = error.code === 'agent_hub_unavailable'
    return {
      code: error.code,
      status: error.status,
      message: agentHubDown
        ? 'Agent Hub is not reachable.'
        : error.code === 'stale_generation' || error.code === 'identity_changed'
          ? 'This session changed. Reopen the window.'
          : error.code === 'workload_unavailable'
            ? 'This session is not ready yet.'
            : error.code === 'unknown_model'
              ? 'Agent Hub cannot use that model. Pick another.'
              : `Aico's session service refused the request (${error.code}).`,
    }
  }
  if (error instanceof TetherUnavailable)
    return { code: 'tether_unavailable', message: "Aico's session service is not reachable." }
  if (error instanceof ChatRefusal) return { code: error.code, message: error.message }
  return { code: 'chat_failed', message: 'The chat request failed.' }
}

class ChatRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function createChatBridge(deps: ChatBridgeDeps) {
  const { tether, catalog, registry } = deps
  let nextStream = 1
  // webContents id -> stream id -> abort
  const streams = new Map<number, Map<string, AbortController>>()

  /** The session the sender's window shows, if it is an Agent Hub chat. */
  async function chatSession(
    sender: WebContents,
  ): Promise<{ descriptor: SessionDescriptor; info: ChatInfo } | null> {
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
    if (descriptor.backend !== 'agent-hub' || !descriptor.agentHub) return null
    return {
      descriptor,
      info: {
        sessionId: descriptor.agentHub.sessionId,
        agentSlug: descriptor.agentHub.agentSlug,
        requestedModel: descriptor.agentHub.requestedModel,
      },
    }
  }

  /** The current descriptor (its generation moves), else the one the window opened with. */
  function fresh(descriptor: SessionDescriptor): SessionDescriptor {
    return catalog.get(descriptor.id) ?? descriptor
  }

  function sessionPath(descriptor: SessionDescriptor, tail = ''): string {
    return `/v1/sessions/${encodeURIComponent(descriptor.id)}/chat${tail}`
  }

  async function call(
    sender: WebContents,
    method: unknown,
    args: unknown,
  ): Promise<ChatCallResult> {
    try {
      if (typeof method !== 'string' || !METHODS.has(method))
        throw new ChatRefusal('unknown_method', 'Unknown chat request.')
      const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
      const target = await chatSession(sender)
      if (!target) throw new ChatRefusal('not_a_chat', 'This window is not an Agent Hub chat.')
      if (method === 'models') {
        const { body } = await tether.request<{ items: unknown }>('GET', '/v1/chat/models')
        return { ok: true, value: body.items }
      }
      if (input.sessionId !== target.info.sessionId)
        throw new ChatRefusal('session_mismatch', 'That is not this window’s session.')
      if (method === 'session' || method === 'queue') {
        const { body } = await tether.request<{ session: unknown; queued: string[] }>(
          'GET',
          sessionPath(target.descriptor, method === 'queue' ? '?messages=false' : ''),
          undefined,
          { timeoutMs: 20_000 },
        )
        return { ok: true, value: method === 'queue' ? body.queued : body.session }
      }
      const current = fresh(target.descriptor)
      if (method === 'send') {
        const text = input.text
        if (typeof text !== 'string' || !text.trim() || text.length > MAX_CHAT_TEXT)
          throw new ChatRefusal('invalid_text', 'That message cannot be sent.')
        // The model chosen for this message: an id, or null (or empty) for the agent's own
        // routing. A call that names none leaves the session's model alone.
        const model = input.model
        if (
          model !== undefined &&
          model !== null &&
          (typeof model !== 'string' || model.length > MAX_MODEL_ID)
        )
          throw new ChatRefusal('invalid_model', 'That model cannot be used.')
        const { body } = await tether.request<{ queued?: boolean }>(
          'POST',
          `/v1/sessions/${encodeURIComponent(current.id)}/inject`,
          {
            generation: current.generation,
            text,
            mode: 'paste',
            submit: true,
            ...(model === undefined ? {} : { model: model || null }),
          },
          { timeoutMs: 45_000 },
        )
        return { ok: true, value: { queued: body.queued === true } }
      }
      const { body } = await tether.request<{ cancelled?: boolean }>(
        'POST',
        sessionPath(current, '/cancel'),
        { generation: current.generation },
        { timeoutMs: 20_000 },
      )
      return { ok: true, value: { cancelled: body.cancelled === true } }
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
    const after =
      typeof afterSeq === 'number' && Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0
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
    let ended = false
    void tether
      .stream(
        `${sessionPath(target.descriptor, '/stream')}?afterSeq=${after}`,
        {},
        (line) => {
          const item = line as Record<string, unknown> | null
          if (!item || typeof item.type !== 'string' || item.type === 'heartbeat') return
          if (item.type === 'stream_error') {
            ended = true
            push({
              kind: 'error',
              error: {
                code: typeof item.code === 'string' ? item.code : 'stream_interrupted',
                message: 'The connection to the running turn was lost.',
              },
            })
            return
          }
          push({ kind: 'event', event: item })
        },
        controller.signal,
      )
      .then(
        () => {
          if (!ended) push({ kind: 'end' })
        },
        (error: unknown) => push({ kind: 'error', error: failure(error) }),
      )
      .finally(() => forgetStream(webContents.id, streamId))
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
