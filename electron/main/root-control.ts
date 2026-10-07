import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAbsolute, normalize } from 'node:path'
import { ownerSocketPath } from './owner-control'
import { sessionGeneration } from './owner-retirement'
import {
  type Bounds,
  getRootRequest,
  getWidget,
  listRootRequests,
  type RootRequestRow,
  reserveRootRequest,
  type WidgetRow,
} from './store'

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_BODY_BYTES = 128 * 1024

export interface RootCreateRequest {
  requestId: string
  tool: 'codex' | 'claude-code'
  projectId: string
  projectRoot: string
  initialPrompt: string
  role: string
  leadRootReference: string | null
  facetCapsuleRef: string | null
}

export interface RootControlOperations {
  available(): boolean
  validate(request: RootCreateRequest): boolean
  ensure(widgetId: string, initialPrompt: string): Promise<void>
  status(row: WidgetRow): Promise<'running' | 'pending' | 'uncertain'>
  show(widgetId: string, generation: string): Promise<boolean>
  position(widgetId: string, generation: string, bounds: Bounds): Promise<boolean>
}

export function guiSocketPath(
  override = process.env.AICO_GUI_CONTROL_SOCKET,
  runtime = process.env.XDG_RUNTIME_DIR,
  uid = process.getuid?.(),
): string {
  return ownerSocketPath(
    override ?? `${runtime || `/run/user/${uid}`}/aico/gui-control.sock`,
    runtime,
    uid,
  )
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseRootCreate(value: unknown): RootCreateRequest | null {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'requestId',
          'tool',
          'projectId',
          'projectRoot',
          'initialPrompt',
          'role',
          'leadRootReference',
          'facetCapsuleRef',
        ].includes(key),
    )
  )
    return null
  const {
    requestId,
    tool,
    projectId,
    projectRoot,
    initialPrompt,
    role,
    leadRootReference,
    facetCapsuleRef,
  } = value
  if (
    typeof requestId !== 'string' ||
    !KEY.test(requestId) ||
    (tool !== 'codex' && tool !== 'claude-code') ||
    typeof projectId !== 'string' ||
    !KEY.test(projectId) ||
    typeof projectRoot !== 'string' ||
    !isAbsolute(projectRoot) ||
    normalize(projectRoot) !== projectRoot ||
    projectRoot.includes('\0') ||
    typeof initialPrompt !== 'string' ||
    !initialPrompt.trim() ||
    initialPrompt.includes('\0') ||
    Buffer.byteLength(initialPrompt) > 64 * 1024 ||
    typeof role !== 'string' ||
    !KEY.test(role) ||
    (leadRootReference !== undefined &&
      leadRootReference !== null &&
      (typeof leadRootReference !== 'string' || !KEY.test(leadRootReference))) ||
    (facetCapsuleRef !== undefined &&
      facetCapsuleRef !== null &&
      (typeof facetCapsuleRef !== 'string' || !KEY.test(facetCapsuleRef)))
  )
    return null
  return {
    requestId,
    tool,
    projectId,
    projectRoot,
    initialPrompt,
    role,
    leadRootReference: leadRootReference ?? null,
    facetCapsuleRef: facetCapsuleRef ?? null,
  }
}

export function rootRequestDigest(request: RootCreateRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.tool,
        request.projectId,
        request.projectRoot,
        request.initialPrompt,
        request.role,
        request.leadRootReference,
        request.facetCapsuleRef,
      ]),
    )
    .digest('hex')
}

function parsePosition(value: unknown): { generation: string; bounds: Bounds } | null {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['generation', 'bounds'].includes(key)) ||
    typeof value.generation !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.generation) ||
    !object(value.bounds)
  )
    return null
  const bounds = value.bounds
  if (
    Object.keys(bounds).length !== 4 ||
    ['x', 'y', 'width', 'height'].some(
      (key) =>
        typeof bounds[key] !== 'number' ||
        !Number.isSafeInteger(bounds[key]) ||
        Math.abs(bounds[key] as number) > 100_000,
    ) ||
    (bounds.width as number) < 360 ||
    (bounds.height as number) < 240
  )
    return null
  return { generation: value.generation, bounds: bounds as unknown as Bounds }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []
  let bytes = 0
  for await (const part of request) {
    const buffer = Buffer.from(part)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('body limit')
    parts.push(buffer)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

const directedDelivery = {
  available: false,
  reason: 'exact_thread_generation_receipt_unqualified',
} as const

export function createRootServer(operations: RootControlOperations) {
  // A failed or disconnected request retains its reservation. Subsequent calls
  // reconcile that exact widget through Aico's existing launch gate.
  const pending = new Map<string, Promise<void>>()
  const serialize = async (key: string, action: () => Promise<void>) => {
    const prior = pending.get(key) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(action)
    pending.set(key, next)
    try {
      await next
    } finally {
      if (pending.get(key) === next) pending.delete(key)
    }
  }
  const describe = async (root: RootRequestRow) => {
    const row = getWidget(root.widgetId)
    return {
      owner: 'aico',
      requestId: root.requestId,
      digest: root.digest,
      hostIdentity: root.widgetId,
      logicalSessionId: root.logicalSessionId,
      generation: row ? sessionGeneration(row) : null,
      surfaceLocator: `aico://widget/${root.widgetId}`,
      role: root.role,
      leadRootReference: root.leadRootReference,
      facetCapsuleRef: root.facetCapsuleRef,
      status: row ? await operations.status(row) : 'ended',
      tool: row?.tool ?? null,
      bounds: row?.bounds ?? null,
      directedDelivery,
    }
  }
  return createServer(async (request, response) => {
    const path = request.url?.split('?')[0] ?? ''
    if (!operations.available()) {
      json(response, 503, { error: 'gui_unavailable' })
      return
    }
    try {
      if (path === '/v1/roots' && request.method === 'GET') {
        json(response, 200, {
          owner: 'aico',
          available: true,
          directedDelivery,
          roots: await Promise.all(listRootRequests().map(describe)),
        })
        return
      }
      if (path === '/v1/roots' && request.method === 'POST') {
        let parsed: RootCreateRequest | null
        try {
          parsed = parseRootCreate(await body(request))
        } catch {
          parsed = null
        }
        if (!parsed) {
          json(response, 400, { error: 'invalid_body' })
          return
        }
        const input = parsed
        await serialize(input.requestId, async () => {
          const digest = rootRequestDigest(input)
          let root = getRootRequest(input.requestId)
          if (root && root.digest !== digest) {
            json(response, 409, { error: 'request_conflict' })
            return
          }
          if (!root) {
            if (!operations.validate(input)) {
              json(response, 422, { error: 'launch_unavailable' })
              return
            }
            root = reserveRootRequest(
              {
                requestId: input.requestId,
                digest,
                widgetId: randomBytes(4).toString('hex'),
                logicalSessionId: `aico-root-${randomUUID()}`,
                role: input.role,
                leadRootReference: input.leadRootReference,
                facetCapsuleRef: input.facetCapsuleRef,
                createdAt: Date.now(),
              },
              input.tool,
              input.projectId,
              input.projectRoot,
            )
            if (root.digest !== digest) {
              json(response, 409, { error: 'request_conflict' })
              return
            }
          }
          if (getWidget(root.widgetId)) {
            // Do not disclose the launch error or prompt; identity/state is the
            // reconciliation receipt, including an ambiguous launch outcome.
            try {
              await operations.ensure(root.widgetId, input.initialPrompt)
            } catch {
              /* reconcile below */
            }
          }
          const descriptor = await describe(root)
          json(
            response,
            descriptor.status === 'running' || descriptor.status === 'ended' ? 200 : 202,
            descriptor,
          )
        })
        return
      }
      const match =
        /^\/v1\/roots\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\/(show|position|send))?$/.exec(path)
      if (!match) {
        json(response, 404, { error: 'not_found' })
        return
      }
      const root = getRootRequest(match[1])
      if (!root) {
        json(response, 404, { error: 'not_found' })
        return
      }
      if (!match[2] && request.method === 'GET') {
        json(response, 200, await describe(root))
        return
      }
      if (request.method !== 'POST') {
        json(response, 405, { error: 'method_not_allowed' })
        return
      }
      if (match[2] === 'send') {
        json(response, 503, { error: 'directed_delivery_unavailable', directedDelivery })
        return
      }
      if (match[2] !== 'show' && match[2] !== 'position') {
        json(response, 405, { error: 'method_not_allowed' })
        return
      }
      let payload: unknown
      try {
        payload = await body(request)
      } catch {
        json(response, 400, { error: 'invalid_body' })
        return
      }
      const position = match[2] === 'position' ? parsePosition(payload) : null
      const generation = object(payload) ? payload.generation : null
      if (
        typeof generation !== 'string' ||
        !/^[0-9a-f]{64}$/.test(generation) ||
        (match[2] === 'position' && !position) ||
        (match[2] === 'show' && (!object(payload) || Object.keys(payload).length !== 1))
      ) {
        json(response, 400, { error: 'invalid_body' })
        return
      }
      await serialize(root.requestId, async () => {
        const row = getWidget(root.widgetId)
        if (!row) {
          json(response, 410, { error: 'ended' })
          return
        }
        if (sessionGeneration(row) !== generation) {
          json(response, 409, { error: 'stale_generation' })
          return
        }
        const success = position
          ? await operations.position(row.id, generation, position.bounds)
          : await operations.show(row.id, generation)
        json(
          response,
          success ? 200 : 409,
          success ? await describe(root) : { error: 'workload_unavailable' },
        )
      })
    } catch {
      json(response, 500, { error: 'owner_failure' })
    }
  })
}
