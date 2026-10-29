import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { type SessionDescriptor, TetherError, TetherUnavailable } from 'tether/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamItem } from '../shared/chat/types'
import { createChatBridge, gitBranch } from './chat-bridge'

const SECRET = 'owner-token-0123456789abcdef'

function descriptor(extra: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: 'ab12cd34',
    ownershipId: 'aico-widget-ab12cd34',
    generation: 'g1',
    status: 'running',
    available: true,
    tool: 'agent-hub',
    name: null,
    label: 'Session 1',
    projectId: 'aico',
    projectRoot: '/srv/aico',
    origin: 'root',
    rootRequestId: null,
    lifecycleVersion: 1,
    tmux: { serverId: null, socket: null, sessionId: null, paneId: null, sessionName: '' },
    createdAt: 1,
    backend: 'agent-hub',
    agentHub: {
      sessionId: 'hub-1',
      agentSlug: 'coder',
      requestedModel: 'deepseek-v4',
      model: 'deepseek-v4',
      turnState: 'idle',
      turnPhase: null,
      queued: 0,
      reachable: true,
      created: true,
      promptSent: true,
    },
    ...extra,
  }
}

function sender(id = 7) {
  const sent: [string, string, ChatStreamItem][] = []
  const listeners: Record<string, () => void> = {}
  const contents = {
    id,
    isDestroyed: () => false,
    send: (channel: string, streamId: string, item: ChatStreamItem) =>
      sent.push([channel, streamId, item]),
    once: (name: string, fn: () => void) => {
      listeners[name] = fn
    },
  } as unknown as WebContents
  return { contents, sent, listeners }
}

function setup(
  session: SessionDescriptor | undefined = descriptor(),
  viewer?: { runId: string; stepKey: string; title: string },
) {
  const request = vi.fn()
  const lines: { path: string; headers: Record<string, string>; signal: AbortSignal }[] = []
  let feed: (line: unknown) => void = () => undefined
  let finish: (error?: Error) => void = () => undefined
  const stream = vi.fn(
    (
      path: string,
      headers: Record<string, string>,
      onLine: (line: unknown) => void,
      signal: AbortSignal,
    ) => {
      lines.push({ path, headers, signal })
      feed = onLine
      return new Promise<void>((resolve, reject) => {
        finish = (error) => (error ? reject(error) : resolve())
        signal.addEventListener('abort', () => resolve())
      })
    },
  )
  const catalog = { get: vi.fn((id: string) => (id === session?.id ? session : undefined)) }
  const bridge = createChatBridge({
    tether: { request, stream } as never,
    catalog,
    registry: {
      senderSession: () => (viewer ? undefined : 'ab12cd34'),
      senderViewer: () => viewer,
    },
  })
  return {
    bridge,
    request,
    stream,
    lines,
    catalog,
    feed: (line: unknown) => feed(line),
    finish: (error?: Error) => finish(error),
  }
}

describe('chat bridge info', () => {
  it('names the window’s Agent Hub session, agent and requested model', async () => {
    const { bridge } = setup()
    await expect(bridge.info(sender().contents)).resolves.toEqual({
      sessionId: 'hub-1',
      agentSlug: 'coder',
      requestedModel: 'deepseek-v4',
      answeredModel: 'deepseek-v4',
    })
  })

  it('is null for a tmux session, so its window stays a terminal', async () => {
    const { bridge } = setup(descriptor({ backend: undefined, agentHub: undefined }))
    await expect(bridge.info(sender().contents)).resolves.toBeNull()
  })

  it('asks Tether when the catalog has not listed the session yet', async () => {
    const { bridge, request, catalog } = setup()
    catalog.get.mockReturnValue(undefined)
    request.mockResolvedValue({ status: 200, body: descriptor() })
    await expect(bridge.info(sender().contents)).resolves.toMatchObject({ sessionId: 'hub-1' })
    expect(request).toHaveBeenCalledWith('GET', '/v1/sessions/ab12cd34')
  })
})

describe('chat bridge calls', () => {
  it('reads the session and the queue from Tether’s chat route', async () => {
    const { bridge, request } = setup()
    request.mockResolvedValueOnce({
      status: 200,
      body: { session: { id: 'hub-1' }, queued: ['a'] },
    })
    await expect(
      bridge.call(sender().contents, 'session', { sessionId: 'hub-1' }),
    ).resolves.toEqual({ ok: true, value: { id: 'hub-1' } })
    expect(request.mock.calls[0].slice(0, 2)).toEqual(['GET', '/v1/sessions/ab12cd34/chat'])

    request.mockResolvedValueOnce({ status: 200, body: { session: {}, queued: ['a', 'b'] } })
    await expect(bridge.call(sender().contents, 'queue', { sessionId: 'hub-1' })).resolves.toEqual({
      ok: true,
      value: ['a', 'b'],
    })
    expect(request.mock.calls[1][1]).toBe('/v1/sessions/ab12cd34/chat?messages=false')
  })

  it('sends a message through the follow-up queue with the session’s current generation', async () => {
    const { bridge, request, catalog } = setup()
    catalog.get.mockReturnValue(descriptor({ generation: 'g2' }))
    request.mockResolvedValue({ status: 200, body: { delivered: true, queued: true } })
    await expect(
      bridge.call(sender().contents, 'send', { sessionId: 'hub-1', text: 'and then?' }),
    ).resolves.toEqual({ ok: true, value: { queued: true } })
    expect(request.mock.calls[0].slice(0, 3)).toEqual([
      'POST',
      '/v1/sessions/ab12cd34/inject',
      { generation: 'g2', text: 'and then?', mode: 'paste', submit: true },
    ])
  })

  it('sends the chosen model with a message: an id, or null for the agent’s own routing', async () => {
    const { bridge, request } = setup()
    request.mockResolvedValue({ status: 200, body: { delivered: true, queued: false } })
    const who = sender().contents
    await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'a', model: 'gemini-flash' })
    await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'b', model: null })
    await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'c', model: '' })
    await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'd' })
    expect(request.mock.calls.map((call) => call[2])).toEqual([
      { generation: 'g1', text: 'a', mode: 'paste', submit: true, model: 'gemini-flash' },
      { generation: 'g1', text: 'b', mode: 'paste', submit: true, model: null },
      { generation: 'g1', text: 'c', mode: 'paste', submit: true, model: null },
      { generation: 'g1', text: 'd', mode: 'paste', submit: true },
    ])
  })

  it('sends the chosen effort with a message: a level word, or none for the model’s default', async () => {
    const { bridge, request } = setup()
    request.mockResolvedValue({ status: 200, body: { delivered: true, queued: false } })
    const who = sender().contents
    await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'a', thinkingLevel: 'high' })
    await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'b', thinkingLevel: null })
    await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'c', thinkingLevel: '' })
    await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'd' })
    expect(request.mock.calls.map((call) => call[2])).toEqual([
      { generation: 'g1', text: 'a', mode: 'paste', submit: true, thinkingLevel: 'high' },
      { generation: 'g1', text: 'b', mode: 'paste', submit: true, thinkingLevel: null },
      { generation: 'g1', text: 'c', mode: 'paste', submit: true, thinkingLevel: null },
      { generation: 'g1', text: 'd', mode: 'paste', submit: true },
    ])
    request.mockClear()
    for (const thinkingLevel of [5, 'High', 'x'.repeat(17), 'high; drop'])
      expect(
        await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'e', thinkingLevel }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_effort' } })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses a model that is not text, and says so when Agent Hub cannot use it', async () => {
    const { bridge, request } = setup()
    const who = sender().contents
    for (const model of [5, { id: 'x' }, 'm'.repeat(129)])
      expect(
        await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'a', model }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_model' } })
    expect(request).not.toHaveBeenCalled()
    request.mockRejectedValueOnce(new TetherError(409, 'unknown_model', {}))
    expect(
      await bridge.call(who, 'send', { sessionId: 'hub-1', text: 'a', model: 'nope' }),
    ).toEqual({
      ok: false,
      error: {
        code: 'unknown_model',
        status: 409,
        message: 'Agent Hub cannot use that model. Pick another.',
      },
    })
  })

  it('cancels the turn and lists models', async () => {
    const { bridge, request } = setup()
    request.mockResolvedValueOnce({ status: 200, body: { cancelled: true, restored: [] } })
    await expect(bridge.call(sender().contents, 'cancel', { sessionId: 'hub-1' })).resolves.toEqual(
      { ok: true, value: { cancelled: true, restored: [] } },
    )
    expect(request.mock.calls[0].slice(0, 3)).toEqual([
      'POST',
      '/v1/sessions/ab12cd34/chat/cancel',
      { generation: 'g1' },
    ])
    // Follow-ups Stop took out of the queue come back as text; nothing else passes through.
    request.mockResolvedValueOnce({
      status: 200,
      body: { cancelled: true, restored: ['and then?', 7, 'again'], token: 'x' },
    })
    await expect(bridge.call(sender().contents, 'cancel', { sessionId: 'hub-1' })).resolves.toEqual(
      { ok: true, value: { cancelled: true, restored: ['and then?', 'again'] } },
    )
    request.mockResolvedValueOnce({ status: 200, body: { items: [{ id: 'm' }] } })
    await expect(bridge.call(sender().contents, 'models', {})).resolves.toEqual({
      ok: true,
      value: [{ id: 'm' }],
    })
  })

  it('refuses another session, an unknown method and bad text without calling Tether', async () => {
    const { bridge, request } = setup()
    const who = sender().contents
    expect(await bridge.call(who, 'session', { sessionId: 'someone-else' })).toMatchObject({
      ok: false,
      error: { code: 'session_mismatch' },
    })
    expect(await bridge.call(who, 'delete', { sessionId: 'hub-1' })).toMatchObject({
      ok: false,
      error: { code: 'unknown_method' },
    })
    for (const text of ['', '   ', 5, 'x'.repeat(60_001)])
      expect(await bridge.call(who, 'send', { sessionId: 'hub-1', text })).toMatchObject({
        ok: false,
        error: { code: 'invalid_text' },
      })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses a window that is not a chat', async () => {
    const { bridge, request } = setup(descriptor({ backend: undefined, agentHub: undefined }))
    expect(await bridge.call(sender().contents, 'models', {})).toMatchObject({
      ok: false,
      error: { code: 'not_a_chat' },
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('reports failures in plain words and never forwards the error text', async () => {
    const { bridge, request } = setup()
    const who = sender().contents
    request.mockRejectedValueOnce(
      new TetherError(503, 'agent_hub_unavailable', { reason: `token ${SECRET}` }),
    )
    const down = await bridge.call(who, 'queue', { sessionId: 'hub-1' })
    expect(down).toEqual({
      ok: false,
      error: { code: 'agent_hub_unavailable', status: 503, message: 'Agent Hub is not reachable.' },
    })
    request.mockRejectedValueOnce(new TetherUnavailable(`connect ECONNREFUSED ${SECRET}`))
    request.mockRejectedValueOnce(new Error(`boom ${SECRET}`))
    const results = [
      down,
      await bridge.call(who, 'queue', { sessionId: 'hub-1' }),
      await bridge.call(who, 'queue', { sessionId: 'hub-1' }),
    ]
    expect(JSON.stringify(results)).not.toContain(SECRET)
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'tether_unavailable' } })
    expect(results[2]).toMatchObject({ ok: false, error: { code: 'chat_failed' } })
  })
})

describe('chat bridge streams', () => {
  it('forwards turn events from Tether’s stream, drops heartbeats and ends the stream', async () => {
    const { bridge, lines, feed, finish } = setup()
    const who = sender()
    const id = await bridge.open(who.contents, 12)
    expect(id).toBe('s1')
    expect(lines[0].path).toBe('/v1/sessions/ab12cd34/chat/stream?afterSeq=12')

    feed({ type: 'heartbeat' })
    feed({ type: 'content', seq: 13, content: 'hi' })
    feed({ type: 'done', seq: 14 })
    finish()
    await vi.waitFor(() => expect(who.sent).toHaveLength(3))
    expect(who.sent).toEqual([
      ['chat:event', 's1', { kind: 'event', event: { type: 'content', seq: 13, content: 'hi' } }],
      ['chat:event', 's1', { kind: 'event', event: { type: 'done', seq: 14 } }],
      ['chat:event', 's1', { kind: 'end' }],
    ])
    await vi.waitFor(() => expect(bridge.openStreams()).toBe(0))
  })

  it('turns a stream_error line and a broken socket into one error item', async () => {
    const { bridge, feed, finish } = setup()
    const first = sender()
    await bridge.open(first.contents, 0)
    feed({ type: 'stream_error', code: 'stream_interrupted', message: SECRET })
    finish()
    await vi.waitFor(() => expect(first.sent).toHaveLength(1))
    expect(first.sent[0][2]).toEqual({
      kind: 'error',
      error: {
        code: 'stream_interrupted',
        message: 'The connection to the running turn was lost.',
      },
    })

    const second = sender(8)
    await bridge.open(second.contents, 0)
    finish(new TetherUnavailable(`stream idle ${SECRET}`))
    await vi.waitFor(() => expect(second.sent).toHaveLength(1))
    expect(JSON.stringify([first.sent, second.sent])).not.toContain(SECRET)
    expect(second.sent[0][2]).toMatchObject({
      kind: 'error',
      error: { code: 'tether_unavailable' },
    })
  })

  it('stops the Tether stream when the renderer closes it or the window goes away', async () => {
    const { bridge, lines } = setup()
    const who = sender()
    const id = (await bridge.open(who.contents, 0)) as string
    bridge.close(who.contents.id, id)
    expect(lines[0].signal.aborted).toBe(true)

    const other = sender(9)
    await bridge.open(other.contents, 0)
    other.listeners.destroyed()
    expect(lines[1].signal.aborted).toBe(true)
  })

  it('keeps a window to a few streams and refuses a stream for a terminal window', async () => {
    const { bridge } = setup()
    const who = sender()
    for (let n = 0; n < 4; n++) expect(typeof (await bridge.open(who.contents, 0))).toBe('string')
    expect(await bridge.open(who.contents, 0)).toMatchObject({ code: 'too_many_streams' })

    const plain = setup(descriptor({ backend: undefined, agentHub: undefined }))
    expect(await plain.bridge.open(sender().contents, 0)).toMatchObject({ code: 'not_a_chat' })
  })

  it('registers its channels exactly once', () => {
    const { bridge } = setup()
    const handle = vi.fn()
    const on = vi.fn()
    bridge.registerIpc({ handle, on } as never)
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      'chat:info',
      'chat:call',
      'chat:stream-open',
    ])
    expect(on.mock.calls.map(([channel]) => channel)).toEqual(['chat:stream-close'])
  })
})

describe('the renderer side holds no credential', () => {
  it('names no token, owner or Agent Hub address in the preload or renderer sources', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const root = resolve(import.meta.dirname, '..')
    const files = [
      resolve(root, 'preload/index.ts'),
      ...readdirSync(resolve(root, 'renderer'), { recursive: true, encoding: 'utf8' })
        .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name))
        .map((name) => resolve(root, 'renderer', name)),
    ]
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/owner[-_ ]?token|OWNER_TOKEN|AGENT_HUB_URL|:8003/i)
    }
  })
})

describe('gitBranch', () => {
  const made: string[] = []
  const folder = () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-branch-'))
    made.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reads the checked-out branch of a repository', () => {
    const dir = folder()
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/fix/order-total\n')
    expect(gitBranch(dir)).toBe('fix/order-total')
  })

  it('follows a linked worktree to its own HEAD', () => {
    const dir = folder()
    const real = join(dir, 'gitdirs', 'wt')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/feature\n')
    mkdirSync(join(dir, 'wt'))
    writeFileSync(join(dir, 'wt', '.git'), `gitdir: ${real}\n`)
    expect(gitBranch(join(dir, 'wt'))).toBe('feature')
  })

  it('is null for a detached HEAD, a plain folder and no folder', () => {
    const dir = folder()
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), '0123456789abcdef\n')
    expect(gitBranch(dir)).toBeNull()
    expect(gitBranch(folder())).toBeNull()
    expect(gitBranch(null)).toBeNull()
  })
})

describe('chat bridge reading a workflow step', () => {
  const viewer = { runId: 'r1', stepKey: 'lint-fix', title: 'lint-fix — Proof run' }
  const attempt = { sessionId: 'attempt-9', agentSlug: 'coder', requestedModel: 'x/m', attempt: 2 }

  it('opens read only on the step’s latest attempt session, asking Tether once', async () => {
    const { bridge, request } = setup(descriptor(), viewer)
    request.mockResolvedValue({ status: 200, body: attempt })
    const window = sender(11).contents
    await expect(bridge.info(window)).resolves.toEqual({
      sessionId: 'attempt-9',
      agentSlug: 'coder',
      requestedModel: 'x/m',
      readOnly: true,
    })
    await bridge.info(window)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0].slice(0, 2)).toEqual([
      'GET',
      '/v1/runs/r1/steps/lint-fix/chat/info',
    ])
  })

  it('reads the attempt through the run route, pinned to the session it opened with', async () => {
    const { bridge, request } = setup(descriptor(), viewer)
    request.mockResolvedValueOnce({ status: 200, body: attempt })
    const window = sender(12).contents
    await bridge.info(window)
    request.mockResolvedValueOnce({
      status: 200,
      body: { session: { id: 'attempt-9' }, queued: [] },
    })
    await expect(bridge.call(window, 'session', { sessionId: 'attempt-9' })).resolves.toEqual({
      ok: true,
      value: { id: 'attempt-9' },
    })
    expect(request.mock.calls[1][1]).toBe('/v1/runs/r1/steps/lint-fix/chat?session=attempt-9')
    await expect(bridge.call(window, 'queue', { sessionId: 'attempt-9' })).resolves.toEqual({
      ok: true,
      value: [],
    })
  })

  it('never sends a message or stops a turn, and refuses another session', async () => {
    const { bridge, request } = setup(descriptor(), viewer)
    request.mockResolvedValueOnce({ status: 200, body: attempt })
    const window = sender(13).contents
    await bridge.info(window)
    for (const method of ['send', 'cancel'])
      await expect(
        bridge.call(window, method, { sessionId: 'attempt-9', text: 'hello' }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'read_only' } })
    await expect(bridge.call(window, 'session', { sessionId: 'hub-1' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'session_mismatch' },
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('follows the attempt’s events through the run route', async () => {
    const { bridge, request, lines } = setup(descriptor(), viewer)
    request.mockResolvedValueOnce({ status: 200, body: attempt })
    const window = sender(14)
    const id = await bridge.open(window.contents, 5)
    expect(typeof id).toBe('string')
    expect(lines[0]?.path).toBe(
      '/v1/runs/r1/steps/lint-fix/chat/stream?session=attempt-9&afterSeq=5',
    )
    bridge.close(14, id as string)
  })
})
