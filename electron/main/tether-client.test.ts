import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyStreamEvent,
  attachEnvironment,
  attachSocketTarget,
  compatibleVersion,
  eventSession,
  eventStreamPath,
  followEvents,
  holdGuiChannel,
  parseAttachTarget,
  parseContextHook,
  parseGuiCommand,
  parsePaneMode,
  reconnectDelay,
  splitNdjson,
  TetherClient,
  TetherError,
  type TetherEvent,
  TetherUnavailable,
  tetherSocketPath,
} from './tether-client'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function fakeTether(handler: Handler): Promise<{ client: TetherClient; server: Server }> {
  const dir = mkdtempSync(join(tmpdir(), 'aico-tether-test-'))
  const socket = join(dir, 'control.sock')
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  cleanups.push(() => {
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { client: new TetherClient(socket, 1_000), server }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
    })
    req.on('end', () => resolve(text ? JSON.parse(text) : null))
  })
}

const event = (seq: number, type: string, bootId = 'boot-a'): TetherEvent => ({
  seq,
  bootId,
  type,
  at: 0,
  data: {},
})

describe('Tether socket path', () => {
  it('prefers TETHER_SOCKET, then the instance under XDG_RUNTIME_DIR', () => {
    expect(tetherSocketPath({ TETHER_SOCKET: '/x/y.sock' }, 1000)).toBe('/x/y.sock')
    expect(tetherSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toBe(
      '/run/user/1000/tether/default/control.sock',
    )
    expect(tetherSocketPath({ TETHER_INSTANCE: 'dev' }, 1000)).toBe(
      '/run/user/1000/tether/dev/control.sock',
    )
  })
})

describe('version compatibility', () => {
  it('needs API 1 or later that still accepts this Aico', () => {
    const v = { name: 'tether', version: '0.0.1', apiVersion: 1, minApiVersion: 1 }
    expect(compatibleVersion(v)).toBe(true)
    expect(compatibleVersion({ ...v, apiVersion: 0 })).toBe(false)
    expect(compatibleVersion({ ...v, apiVersion: 3, minApiVersion: 2 })).toBe(false)
    expect(compatibleVersion({ ...v, apiVersion: 2, minApiVersion: 1 })).toBe(true)
  })
})

describe('attach target', () => {
  const target = {
    generation: 'a'.repeat(64),
    argv: ['/usr/bin/tmux', '-S', '/s/server.sock', 'attach-session', '-t', '$3'],
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', CLICOLOR: '1' },
    unset: ['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR', 'NO_COLOR'],
  }

  it('applies overrides over the client environment, then removes unset keys', () => {
    const env = attachEnvironment(
      { HOME: '/h', TERM: 'dumb', TMUX: '/tmp/x,1,0', NO_COLOR: '1', EMPTY: undefined },
      target,
    )
    expect(env).toEqual({
      HOME: '/h',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CLICOLOR: '1',
    })
  })

  it('validates the answer and names the socket and target for view queries', () => {
    expect(parseAttachTarget(target)).toEqual(target)
    expect(() => parseAttachTarget({ ...target, argv: ['tmux', 'attach'] })).toThrow(
      TetherUnavailable,
    )
    expect(() => parseAttachTarget({ ...target, env: { TERM: 1 } })).toThrow(TetherUnavailable)
    expect(attachSocketTarget(target.argv)).toEqual({ socket: '/s/server.sock', target: '$3' })
    expect(attachSocketTarget(['/usr/bin/tmux', 'attach'])).toBeNull()
  })
})

describe('NDJSON and event cursor', () => {
  it('splits complete lines and keeps the partial tail', () => {
    expect(splitNdjson('{"a":1}\n\n{"b":2}\n{"c"')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c"',
    })
  })

  it('resyncs on first hello, gap and daemon restart; drops replayed events', () => {
    let step = applyStreamEvent({ bootId: null, seq: 0 }, event(7, 'hello'))
    expect(step).toEqual({ cursor: { bootId: 'boot-a', seq: 7 }, deliver: false, resync: true })
    step = applyStreamEvent(step.cursor, event(8, 'session.created'))
    expect(step).toMatchObject({ cursor: { seq: 8 }, deliver: true, resync: false })
    expect(applyStreamEvent(step.cursor, event(8, 'session.created')).deliver).toBe(false)
    expect(applyStreamEvent(step.cursor, event(8, 'heartbeat'))).toMatchObject({
      deliver: false,
      resync: false,
    })
    expect(applyStreamEvent(step.cursor, event(8, 'hello')).resync).toBe(false)
    expect(applyStreamEvent(step.cursor, event(20, 'gap')).resync).toBe(true)
    expect(applyStreamEvent(step.cursor, event(1, 'hello', 'boot-b'))).toEqual({
      cursor: { bootId: 'boot-b', seq: 1 },
      deliver: false,
      resync: true,
    })
    expect(eventStreamPath({ bootId: null, seq: 0 })).toBe('/v1/events')
    expect(eventStreamPath({ bootId: 'b', seq: 4 })).toBe('/v1/events?since=4&bootId=b')
  })

  it('backs off exponentially to a cap', () => {
    expect(reconnectDelay(0)).toBe(500)
    expect(reconnectDelay(2)).toBe(2000)
    expect(reconnectDelay(50)).toBe(10_000)
  })
})

describe('Tether requests', () => {
  it('maps stable error codes and a missing socket', async () => {
    const { client } = await fakeTether((req, res) => {
      if (req.url === '/v1/sessions/0a1b2c3d/end')
        json(res, 409, { error: 'blocked', reason: 'scope cleanup unproven' })
      else json(res, 404, { error: 'not_found' })
    })
    const blocked = await client.end('0a1b2c3d', 'a'.repeat(64)).catch((e: unknown) => e)
    expect(blocked).toBeInstanceOf(TetherError)
    expect(blocked).toMatchObject({
      status: 409,
      code: 'blocked',
      reason: 'scope cleanup unproven',
    })
    await expect(
      new TetherClient('/nonexistent/tether.sock').listSessions(),
    ).rejects.toBeInstanceOf(TetherUnavailable)
  })

  it('creates sessions as origin aico at the view grid and sends exact bodies', async () => {
    const seen: { method?: string; url?: string; body: unknown }[] = []
    const { client } = await fakeTether(async (req, res) => {
      seen.push({ method: req.method, url: req.url, body: await readBody(req) })
      if (req.url === '/v1/sessions') json(res, 202, { id: '0a1b2c3d', status: 'uncertain' })
      else json(res, 200, { delivered: true })
    })
    const created = await client.createSession({
      tool: 'codex',
      projectId: 'aico',
      size: { cols: 100, rows: 30 },
    })
    expect(created).toMatchObject({ id: '0a1b2c3d', status: 'uncertain' })
    await client.inject('0a1b2c3d', 'b'.repeat(64), '[dom: "x"] ', 'type')
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/sessions',
        body: { tool: 'codex', projectId: 'aico', size: { cols: 100, rows: 30 }, origin: 'aico' },
      },
      {
        method: 'POST',
        url: '/v1/sessions/0a1b2c3d/inject',
        body: { generation: 'b'.repeat(64), text: '[dom: "x"] ', mode: 'type' },
      },
    ])
  })
})

describe('post-cutover routes', () => {
  it('switches to a project or a plain root, reads pane mode and re-checks context', async () => {
    const seen: { method?: string; url?: string; body: unknown }[] = []
    const name = 'summitflow-70b339cd-93a0-4898-8c4b-3d694ce8e8dc'
    const { client } = await fakeTether(async (req, res) => {
      seen.push({ method: req.method, url: req.url, body: await readBody(req) })
      if (req.url?.endsWith('/pane-mode'))
        json(res, 200, {
          generation: 'g',
          alternateScreen: false,
          mouseReporting: true,
          historySize: 4200,
          inMode: true,
          mode: 'copy-mode',
        })
      else if (req.url?.endsWith('/context-check'))
        json(res, 200, {
          generation: 'g',
          contextHook: {
            state: 'available',
            detail: 'ok',
            tool: 'codex',
            applicable: true,
            checkedAt: 5,
          },
        })
      else json(res, 200, { id: '0a1b2c3d' })
    })
    const generation = 'c'.repeat(64)
    await client.switchProject('0a1b2c3d', generation, { projectId: 'aico' })
    await client.switchProject('0a1b2c3d', generation, { projectRoot: '/home/u/pw' })
    expect(await client.paneMode('0a1b2c3d')).toEqual({
      alternateScreen: false,
      mouseReporting: true,
      historySize: 4200,
      inMode: true,
      mode: 'copy-mode',
    })
    expect((await client.legacyPaneMode(name)).historySize).toBe(4200)
    expect(await client.contextCheck('0a1b2c3d')).toEqual({
      state: 'available',
      detail: 'ok',
      tool: 'codex',
      applicable: true,
      checkedAt: 5,
    })
    expect(seen.map(({ method, url, body }) => [method, url, body])).toEqual([
      ['POST', '/v1/sessions/0a1b2c3d/switch-project', { generation, projectId: 'aico' }],
      ['POST', '/v1/sessions/0a1b2c3d/switch-project', { generation, projectRoot: '/home/u/pw' }],
      ['GET', '/v1/sessions/0a1b2c3d/pane-mode', null],
      ['GET', `/v1/legacy-sessions/${name}/pane-mode`, null],
      ['POST', '/v1/sessions/0a1b2c3d/context-check', null],
    ])
  })

  it('reads odd pane-mode and context answers safely', () => {
    expect(parsePaneMode({ historySize: -1, alternateScreen: 'yes' })).toEqual({
      alternateScreen: false,
      mouseReporting: false,
      historySize: 0,
      inMode: false,
      mode: null,
    })
    expect(parseContextHook(undefined)).toBeNull()
    expect(parseContextHook({ state: 'unknown', detail: '', tool: 'shell' })).toBeNull()
  })

  it('takes the session snapshot from an event only when it matches the id', () => {
    const session = {
      id: '0a1b2c3d',
      generation: 'g',
      status: 'running',
      tool: 'codex',
      createdAt: 1,
      tmux: { sessionName: 'aico-0a1b2c3d' },
    }
    const updated = (data: Record<string, unknown>): TetherEvent => ({
      ...event(1, 'session.updated'),
      data,
    })
    expect(eventSession(updated({ id: '0a1b2c3d', generation: 'g', session }))).toEqual(session)
    expect(eventSession(updated({ id: 'ffffffff', session }))).toBeNull()
    expect(eventSession(updated({ id: '0a1b2c3d', generation: 'g' }))).toBeNull()
    expect(
      eventSession(updated({ id: '0a1b2c3d', session: { ...session, tmux: null } })),
    ).toBeNull()
  })
})

describe('legacy A-Term sessions', () => {
  it('lists only exact summitflow names and attaches without a generation', async () => {
    const name = 'summitflow-70b339cd-93a0-4898-8c4b-3d694ce8e8dc'
    const { client } = await fakeTether((req, res) => {
      if (req.url === '/v1/legacy-sessions') {
        json(res, 200, {
          items: [
            {
              kind: 'legacy-attach-only',
              name,
              aTermSessionId: name.slice(11),
              createdAt: 1,
              attachedClients: 0,
            },
            {
              kind: 'legacy-attach-only',
              name: 'summitflow-; rm -rf',
              createdAt: 1,
              attachedClients: 0,
            },
          ],
        })
      } else if (req.url === `/v1/legacy-sessions/${name}/attach`) {
        json(res, 200, {
          argv: [
            '/usr/bin/tmux',
            '-S',
            '/tmp/tmux-1000/default',
            'attach-session',
            '-t',
            `=${name}`,
          ],
          env: {},
          unset: ['TMUX'],
        })
      } else json(res, 404, { error: 'not_found' })
    })
    expect((await client.legacySessions()).map((item) => item.name)).toEqual([name])
    const target = await client.legacyAttach(name)
    expect(target.generation).toBe('')
    expect(attachSocketTarget(target.argv)).toEqual({
      socket: '/tmp/tmux-1000/default',
      target: `=${name}`,
    })
  })
})

describe('event stream', () => {
  it('reconnects with since/bootId and re-lists on a gap', async () => {
    const urls: string[] = []
    let connection = 0
    const { client } = await fakeTether((req, res) => {
      urls.push(req.url ?? '')
      connection += 1
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      if (connection === 1) {
        res.write(`${JSON.stringify(event(3, 'hello'))}\n`)
        res.end(`${JSON.stringify({ ...event(4, 'session.ended'), data: { id: '0a1b2c3d' } })}\n`)
      } else {
        res.write(`${JSON.stringify(event(9, 'hello'))}\n`)
        res.write(`${JSON.stringify(event(9, 'gap'))}\n`)
      }
    })
    const seen: string[] = []
    let resyncs = 0
    const stop = followEvents(client, {
      onResync: () => {
        resyncs += 1
      },
      onEvent: (e) => seen.push(`${e.type}:${String(e.data.id)}`),
    })
    cleanups.push(stop)
    await expect.poll(() => connection, { timeout: 3_000 }).toBe(2)
    await expect.poll(() => resyncs).toBe(2)
    expect(seen).toEqual(['session.ended:0a1b2c3d'])
    expect(urls).toEqual(['/v1/events', '/v1/events?since=4&bootId=boot-a'])
  })
})

describe('GUI channel', () => {
  it('parses only well-formed commands', () => {
    const base = { type: 'command', commandId: 'c1', sessionId: '0a1b2c3d', generation: 'g' }
    expect(parseGuiCommand({ ...base, kind: 'show' })).toEqual({
      commandId: 'c1',
      kind: 'show',
      sessionId: '0a1b2c3d',
      generation: 'g',
    })
    expect(
      parseGuiCommand({
        ...base,
        kind: 'position',
        bounds: { x: 1, y: 2, width: 900, height: 600 },
      })?.bounds,
    ).toEqual({ x: 1, y: 2, width: 900, height: 600 })
    expect(parseGuiCommand({ ...base, kind: 'position', bounds: { x: 1.5 } })).toBeNull()
    expect(parseGuiCommand({ ...base, kind: 'title' })).toBeNull()
    expect(parseGuiCommand({ ...base, kind: 'coordinator', coordinator: true })?.coordinator).toBe(
      true,
    )
    expect(parseGuiCommand({ ...base, kind: 'coordinator', coordinator: 'yes' })).toBeNull()
    expect(parseGuiCommand({ ...base, kind: 'coordinator' })).toBeNull()
    expect(parseGuiCommand({ ...base, kind: 'show', sessionId: '../x' })).toBeNull()
    expect(parseGuiCommand({ type: 'heartbeat' })).toBeNull()
  })

  it('identifies as aico-gui, applies commands and posts each verdict', async () => {
    const results: { url?: string; body: unknown }[] = []
    let header: string | undefined
    const { client } = await fakeTether(async (req, res) => {
      if (req.url === '/v1/gui/channel') {
        header = req.headers['x-tether-client'] as string
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(`${JSON.stringify({ type: 'hello' })}\n`)
        for (const [commandId, kind] of [
          ['c1', 'show'],
          ['c2', 'title'],
        ])
          res.write(
            `${JSON.stringify({ type: 'command', commandId, kind, sessionId: '0a1b2c3d', generation: 'g', label: 'Focus' })}\n`,
          )
        return
      }
      results.push({ url: req.url, body: await readBody(req) })
      json(res, 200, { accepted: true })
    })
    const stop = holdGuiChannel(client, async (command) =>
      command.kind === 'show' ? { applied: true } : { applied: false, error: 'stale_generation' },
    )
    cleanups.push(stop)
    await expect.poll(() => results.length, { timeout: 3_000 }).toBe(2)
    expect(header).toBe('aico-gui')
    expect(results).toContainEqual({ url: '/v1/gui/results/c1', body: { applied: true } })
    expect(results).toContainEqual({
      url: '/v1/gui/results/c2',
      body: { applied: false, error: 'stale_generation' },
    })
  })

  it('stops for good when another GUI supersedes it', async () => {
    let connections = 0
    const { client } = await fakeTether((_req, res) => {
      connections += 1
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(`${JSON.stringify({ type: 'superseded' })}\n`)
    })
    const stop = holdGuiChannel(client, async () => ({ applied: true }))
    cleanups.push(stop)
    await expect.poll(() => connections).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(connections).toBe(1)
  })
})
