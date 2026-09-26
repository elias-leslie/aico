import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { LifecycleOwnerLock } from './lifecycle-guard'
import {
  type RetirementOperations,
  retireOwnedSession,
  sessionGeneration,
} from './owner-retirement'
import { MANAGED_LIFECYCLE_VERSION } from './ownership'
import { getWidget } from './store'

const WIDGET_ID_RE = /^[0-9a-f]{8}$/
const MAX_BODY_BYTES = 1024
const owners = new LifecycleOwnerLock()

export function ownerSocketPath(
  override: string | undefined = process.env.AICO_CONTROL_SOCKET,
  runtime: string | undefined = process.env.XDG_RUNTIME_DIR,
  uid: number | undefined = process.getuid?.(),
): string {
  const root = runtime || (uid === undefined ? '' : `/run/user/${uid}`)
  const path = override ?? join(root, 'aico', 'control.sock')
  if (
    !path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..')) ||
    Buffer.byteLength(path) > 107
  )
    throw new Error('invalid Aico owner socket path')
  return path
}

function json(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let text = ''
  for await (const part of request) {
    text += part.toString('utf8')
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('request body too large')
  }
  return JSON.parse(text)
}

export function createOwnerServer(operations: RetirementOperations): Server {
  return createServer(async (request, response) => {
    const path = request.url?.split('?')[0] ?? ''
    const match = /^\/v1\/sessions\/([0-9a-f]{8})(\/end)?$/.exec(path)
    if (!match || !WIDGET_ID_RE.test(match[1])) {
      json(response, 404, { error: 'not_found' })
      return
    }
    const widgetId = match[1]
    try {
      if (request.method === 'GET' && !match[2]) {
        const row = getWidget(widgetId)
        if (
          !row ||
          row.externalTmuxSession ||
          row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION ||
          !row.tmuxServerId ||
          !row.tmuxSessionId ||
          !row.paneId ||
          !(await operations.verifiedCurrentPane(row))
        ) {
          json(response, 404, { error: 'not_found' })
          return
        }
        json(response, 200, {
          owner: 'aico',
          widgetId,
          sessionId: row.sessionId,
          generation: sessionGeneration(row),
          tmuxSessionId: row.tmuxSessionId,
          paneId: row.paneId,
        })
        return
      }
      if (request.method === 'POST' && match[2]) {
        let body: unknown
        try {
          body = await readJson(request)
        } catch {
          json(response, 400, { error: 'invalid_body' })
          return
        }
        const generation =
          body && typeof body === 'object' && 'generation' in body
            ? (body as { generation: unknown }).generation
            : null
        if (typeof generation !== 'string' || !/^[0-9a-f]{64}$/.test(generation)) {
          json(response, 400, { error: 'invalid_generation' })
          return
        }
        const owner = owners.acquire(widgetId)
        if (!owner) {
          json(response, 409, { error: 'busy' })
          return
        }
        try {
          const result = await retireOwnedSession(widgetId, operations, generation)
          if (result.status === 'ended') json(response, 200, { status: 'ended' })
          else if (result.status === 'absent') json(response, 404, { error: 'not_found' })
          else if (result.status === 'stale') json(response, 409, { error: 'stale_generation' })
          else json(response, 409, { error: 'blocked', reason: result.reason })
        } finally {
          owners.release(owner)
        }
        return
      }
      json(response, 405, { error: 'method_not_allowed' })
    } catch (error) {
      console.error('[aico:owner] request failed:', error)
      json(response, 500, { error: 'owner_failure' })
    }
  })
}

async function isLiveSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection(path)
    client.once('connect', () => {
      client.destroy()
      resolve(true)
    })
    client.once('error', () => resolve(false))
  })
}

export async function listenOwnerServer(server: Server, path: string): Promise<void> {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error('Aico owner socket directory is not owned by this user')
  }
  chmodSync(directory, 0o700)
  if (existsSync(path)) {
    const existing = lstatSync(path)
    if (!existing.isSocket() || existing.uid !== process.getuid?.() || (await isLiveSocket(path))) {
      throw new Error('Aico owner socket is already in use or unsafe')
    }
    unlinkSync(path)
  }
  const previousUmask = process.umask(0o077)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(path, 0o600)
  } finally {
    process.umask(previousUmask)
  }
}
