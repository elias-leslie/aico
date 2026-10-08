import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAbsolute, normalize } from 'node:path'
import type { LifecycleOwnerToken, ManagedGateState } from './lifecycle-guard'
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
import { isBoundedTerminalText } from './tmux'
import { isResumeSessionId } from './tui/launch'
import { getTui } from './tui/registry'

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_BODY_BYTES = 128 * 1024
// 2000 UTF-8 bytes can occupy 12000 bytes with JSON \uXXXX escaping,
// plus the fixed fields and bounded request key. Accept either JSON encoding.
const MAX_ADMIN_BODY_BYTES = 16 * 1024

export interface RootCreateRequest {
  requestId: string
  tool: 'codex' | 'claude-code'
  projectId: string
  projectRoot: string
  initialPrompt: string
  role: string
  leadRootReference: string | null
  facetCapsuleRef: string | null
  resumeSessionId: string | null
}

/** One canonical view mutation, shared by retained-root and ordinary-widget routes. */
export type WidgetMutation =
  | { kind: 'show' }
  | { kind: 'position'; bounds: Bounds }
  | { kind: 'title'; label: string }

export interface RootControlOperations {
  available(): boolean
  validate(request: RootCreateRequest): boolean
  ensure(widgetId: string, initialPrompt: string, resumeSessionId: string | null): Promise<void>
  status(row: WidgetRow): Promise<'running' | 'pending' | 'uncertain'>
  mutate(widgetId: string, generation: string, mutation: WidgetMutation): Promise<boolean>
}

/**
 * Apply one view mutation only to the exact running widget generation.
 *
 * Every kind requires a dispatched launch and an active managed workload,
 * verified while holding lifecycle ownership, then rereads the catalog before
 * applying. A non-running widget is never shown, positioned or renamed.
 */
export async function widgetMutationOperation(
  widgetId: string,
  generation: string,
  operations: {
    acquire(widgetId: string): LifecycleOwnerToken | null
    release(widgetId: string, owner: LifecycleOwnerToken): void
    getWidget(widgetId: string): WidgetRow | undefined
    gateState(row: WidgetRow): Promise<ManagedGateState | null>
    apply(row: WidgetRow): void
  },
): Promise<boolean> {
  const owner = operations.acquire(widgetId)
  if (!owner) return false
  try {
    const exact = (row: WidgetRow | undefined): row is WidgetRow =>
      Boolean(
        row &&
          row.id === widgetId &&
          sessionGeneration(row) === generation &&
          row.launchState === 'dispatched',
      )
    const row = operations.getWidget(widgetId)
    if (!exact(row) || (await operations.gateState(row)) !== 'active-workload') return false
    const latest = operations.getWidget(widgetId)
    if (!exact(latest)) return false
    operations.apply(latest)
    return true
  } finally {
    operations.release(widgetId, owner)
  }
}

type RootAdminRequest = {
  requestKey: string
  generation: string
  expectedThreadId: string
} & ({ kind: 'clear' } | { kind: 'submit'; text: string })

function parseAdmin(value: unknown): RootAdminRequest | null {
  if (
    !object(value) ||
    (value.kind !== 'clear' && value.kind !== 'submit') ||
    Object.keys(value).some(
      (key) =>
        ![
          'kind',
          'requestKey',
          'generation',
          'expectedThreadId',
          ...(value.kind === 'submit' ? ['text'] : []),
        ].includes(key),
    ) ||
    typeof value.requestKey !== 'string' ||
    !KEY.test(value.requestKey) ||
    typeof value.generation !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.generation) ||
    typeof value.expectedThreadId !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.expectedThreadId) ||
    (value.kind === 'submit' && !isBoundedTerminalText(value.text))
  )
    return null
  const pin = {
    requestKey: value.requestKey,
    generation: value.generation,
    expectedThreadId: value.expectedThreadId,
  }
  return value.kind === 'clear'
    ? { ...pin, kind: 'clear' }
    : { ...pin, kind: 'submit', text: value.text as string }
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
          'resumeSessionId',
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
    resumeSessionId,
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
    (resumeSessionId !== undefined &&
      resumeSessionId !== null &&
      (!isResumeSessionId(getTui(tool), resumeSessionId) ||
        !isBoundedTerminalText(initialPrompt))) ||
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
    resumeSessionId: resumeSessionId ?? null,
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
        ...(request.resumeSessionId ? [request.resumeSessionId] : []),
      ]),
    )
    .digest('hex')
}

/** Owner-side validation; contracts/view-mutation-vectors.json pins every client copy. */
export function parseBounds(value: unknown): Bounds | null {
  if (
    !object(value) ||
    Object.keys(value).length !== 4 ||
    ['x', 'y', 'width', 'height'].some(
      (key) =>
        typeof value[key] !== 'number' ||
        !Number.isSafeInteger(value[key]) ||
        Math.abs(value[key] as number) > 100_000,
    ) ||
    (value.width as number) < 360 ||
    (value.height as number) < 240
  )
    return null
  return { x: value.x, y: value.y, width: value.width, height: value.height } as Bounds
}

/** Trim (ECMAScript TrimString), then require 1-160 UTF-8 bytes of single-line text. */
export function parseLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  if (!label || Buffer.byteLength(label) > 160) return null
  for (const character of label) {
    const code = character.codePointAt(0) ?? 0
    if (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0x2028 ||
      code === 0x2029
    )
      return null
  }
  return label
}

/** Strict mutation body: exactly the generation plus the kind's one field. */
export function parseWidgetMutation(
  kind: WidgetMutation['kind'],
  value: unknown,
): { generation: string; mutation: WidgetMutation } | null {
  const field = kind === 'position' ? 'bounds' : kind === 'title' ? 'label' : null
  if (
    !object(value) ||
    Object.keys(value).some((key) => key !== 'generation' && key !== field) ||
    (field !== null && !(field in value)) ||
    typeof value.generation !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.generation)
  )
    return null
  const generation = value.generation
  if (kind === 'show') return { generation, mutation: { kind } }
  if (kind === 'position') {
    const bounds = parseBounds(value.bounds)
    return bounds ? { generation, mutation: { kind, bounds } } : null
  }
  const label = parseLabel(value.label)
  return label ? { generation, mutation: { kind, label } } : null
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const parts: Buffer[] = []
  let bytes = 0
  for await (const part of request) {
    const buffer = Buffer.from(part)
    bytes += buffer.length
    if (bytes > limit) throw new Error('body limit')
    parts.push(buffer)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

const directedDelivery = {
  available: false,
  reason: 'exact_thread_generation_receipt_unqualified',
} as const

const terminalAdmin = {
  available: false,
  reason: 'native_tui_atomic_compare_and_apply_unavailable',
  operations: ['clear', 'submit'],
  framing: 'bracketed_paste',
  missing: ['current_thread_fence', 'idle_empty_draft_input_fence', 'idempotent_native_receipt'],
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
  const describeWidget = async (row: WidgetRow) => {
    const generation = sessionGeneration(row)
    const status = await operations.status(row)
    const latest = getWidget(row.id)
    if (!latest || latest.id !== row.id || sessionGeneration(latest) !== generation) return null
    return {
      owner: 'aico',
      widgetId: row.id,
      sessionId: row.sessionId,
      generation,
      status,
      available: status === 'running',
    }
  }
  // The one canonical view mutation path for both route families. It
  // serializes on the widget identity, so a root alias and its widget ID can
  // never interleave writes. Rejections here are definitive: nothing applied.
  const mutateWidget = async (
    widgetId: string,
    generation: string,
    mutation: WidgetMutation,
  ): Promise<{ status: number; error: string } | null> => {
    const current = getWidget(widgetId)
    if (!current || current.id !== widgetId) return { status: 410, error: 'ended' }
    if (sessionGeneration(current) !== generation) return { status: 409, error: 'stale_generation' }
    const ready = await describeWidget(current)
    if (!ready) return { status: 409, error: 'stale_generation' }
    if (!ready.available) return { status: 409, error: 'workload_unavailable' }
    if (!(await operations.mutate(widgetId, generation, mutation)))
      return { status: 409, error: 'workload_unavailable' }
    return null
  }
  const readMutation = async (
    request: IncomingMessage,
    kind: WidgetMutation['kind'],
  ): Promise<{ generation: string; mutation: WidgetMutation } | null> => {
    try {
      return parseWidgetMutation(kind, await body(request))
    } catch {
      return null
    }
  }
  return createServer(async (request, response) => {
    const path = request.url?.split('?')[0] ?? ''
    if (!operations.available()) {
      json(response, 503, { error: 'gui_unavailable' })
      return
    }
    try {
      const widgetMatch = /^\/v1\/widgets\/([0-9a-f]{8})(?:\/(title|position))?$/.exec(path)
      if (widgetMatch) {
        const widgetId = widgetMatch[1]
        const row = getWidget(widgetId)
        if (!row || row.id !== widgetId) {
          json(response, 404, { error: 'not_found' })
          return
        }
        if (!widgetMatch[2] && request.method === 'GET') {
          const descriptor = await describeWidget(row)
          json(response, descriptor ? 200 : 409, descriptor ?? { error: 'stale_generation' })
          return
        }
        if (!widgetMatch[2] || request.method !== 'POST') {
          json(response, 405, { error: 'method_not_allowed' })
          return
        }
        const input = await readMutation(request, widgetMatch[2] as 'title' | 'position')
        if (!input) {
          json(response, 400, { error: 'invalid_body' })
          return
        }
        await serialize(`widget:${widgetId}`, async () => {
          const rejected = await mutateWidget(widgetId, input.generation, input.mutation)
          if (rejected) {
            json(response, rejected.status, { error: rejected.error })
            return
          }
          const latest = getWidget(widgetId)
          const descriptor =
            latest && sessionGeneration(latest) === input.generation
              ? await describeWidget(latest)
              : null
          // Applied, but the exact identity cannot be re-qualified afterwards.
          json(response, descriptor ? 200 : 409, descriptor ?? { error: 'outcome_uncertain' })
        })
        return
      }
      if (path === '/v1/roots' && request.method === 'GET') {
        json(response, 200, {
          owner: 'aico',
          available: true,
          directedDelivery,
          terminalAdmin,
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
              await operations.ensure(root.widgetId, input.initialPrompt, input.resumeSessionId)
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
        /^\/v1\/roots\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\/(show|position|title|send|admin))?$/.exec(
          path,
        )
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
      if (match[2] === 'admin' && request.method === 'GET') {
        const row = getWidget(root.widgetId)
        json(response, 200, {
          owner: 'aico',
          requestId: root.requestId,
          generation: row ? sessionGeneration(row) : null,
          currentThreadId: null,
          terminalAdmin,
        })
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
      if (match[2] === 'admin') {
        let input: RootAdminRequest | null
        try {
          input = parseAdmin(await body(request, MAX_ADMIN_BODY_BYTES))
        } catch {
          input = null
        }
        if (!input) {
          json(response, 400, { error: 'invalid_body' })
          return
        }
        const admin = input
        await serialize(root.requestId, async () => {
          const row = getWidget(root.widgetId)
          if (!row) {
            json(response, 410, { error: 'ended' })
            return
          }
          if (sessionGeneration(row) !== admin.generation) {
            json(response, 409, { error: 'stale_generation' })
            return
          }
          if (row.tool !== 'codex') {
            json(response, 422, { error: 'unsupported_tool' })
            return
          }
          // No capture/SQL read, sleep, or tmux send can atomically compare the
          // native thread, active turn, draft and concurrent input. Until that
          // native operation exists, even a matching Aico pin must fail closed.
          json(response, 503, {
            error: 'native_tui_atomic_admin_unavailable',
            applied: false,
            kind: admin.kind,
            requestKey: admin.requestKey,
            generation: admin.generation,
            expectedThreadId: admin.expectedThreadId,
            terminalAdmin,
          })
        })
        return
      }
      if (match[2] !== 'show' && match[2] !== 'position' && match[2] !== 'title') {
        json(response, 405, { error: 'method_not_allowed' })
        return
      }
      const input = await readMutation(request, match[2])
      if (!input) {
        json(response, 400, { error: 'invalid_body' })
        return
      }
      await serialize(`widget:${root.widgetId}`, async () => {
        const rejected = await mutateWidget(root.widgetId, input.generation, input.mutation)
        json(
          response,
          rejected?.status ?? 200,
          rejected ? { error: rejected.error } : await describe(root),
        )
      })
    } catch {
      json(response, 500, { error: 'owner_failure' })
    }
  })
}
