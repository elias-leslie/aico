/** Launch-bound native Codex RPC. No terminal input or acceptance inference. */
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { ownerSocketPath } from './owner-control'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export type AdminRequest = {
  requestKey: string
  generation: string
  expectedThreadId: string
  expectedEpoch?: string
  expectedInputRevision?: number
} & ({ kind: 'clear' } | { kind: 'submit'; text: string })

export type NativeBinding = { socket: string; launchId: string }
type Metadata = Record<string, unknown>

function object(value: unknown): value is Metadata {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function privatePath(path: string, socket = false): boolean {
  try {
    const stat = lstatSync(path)
    return (
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0 &&
      (socket ? stat.isSocket() : stat.isDirectory())
    )
  } catch {
    return false
  }
}

/** Fresh per-pane binding; retained directories hold content-free native receipts. */
export function nativeAdminEnvironment(
  runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
): Record<string, string> {
  const base = join(runtime, 'aico', 'native')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  if (!privatePath(base)) throw new Error('native admin runtime is not private')
  const parent = mkdtempSync(join(base, 'n-'))
  const socket = ownerSocketPath(join(parent, 'admin.sock'))
  return {
    CODEX_TERMINAL_ADMIN_SOCKET: socket,
    CODEX_TERMINAL_ADMIN_ID: randomBytes(32).toString('hex'),
  }
}

/** Caller supplies only the freshly verified managed pane's immutable environment. */
export function nativeAdminBinding(environment: Map<string, string> | null): NativeBinding | null {
  const socket = environment?.get('CODEX_TERMINAL_ADMIN_SOCKET')
  const launchId = environment?.get('CODEX_TERMINAL_ADMIN_ID')
  if (!socket || !launchId || !SHA256.test(launchId)) return null
  try {
    if (
      ownerSocketPath(socket) !== socket ||
      !privatePath(dirname(socket)) ||
      !privatePath(socket, true)
    )
      return null
    return { socket, launchId }
  } catch {
    return null
  }
}

async function rpc(binding: NativeBinding, request: Metadata): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = createConnection(binding.socket)
    const chunks: Buffer[] = []
    let length = 0
    const timer = setTimeout(() => fail(), 4000)
    const fail = () => {
      clearTimeout(timer)
      client.destroy()
      reject(new Error('native admin unavailable'))
    }
    client.once('error', fail)
    client.once('end', fail)
    client.once('connect', () =>
      client.write(`${JSON.stringify({ launchId: binding.launchId, ...request })}\n`),
    )
    client.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > 16 * 1024) {
        fail()
        return
      }
      chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const newline = bytes.indexOf(10)
      if (newline < 0) return
      clearTimeout(timer)
      client.destroy()
      try {
        resolve(JSON.parse(bytes.subarray(0, newline).toString('utf8')))
      } catch {
        fail()
      }
    })
  })
}

export async function nativeAdminSnapshot(binding: NativeBinding): Promise<Metadata | null> {
  try {
    const value = await rpc(binding, { method: 'snapshot' })
    if (
      !object(value) ||
      value.available !== true ||
      value.protocol !== 'codexTerminalAdmin.v1' ||
      value.launchId !== binding.launchId ||
      typeof value.epoch !== 'string' ||
      !UUID.test(value.epoch) ||
      typeof value.threadId !== 'string' ||
      !UUID.test(value.threadId) ||
      !Number.isSafeInteger(value.inputRevision) ||
      (value.inputRevision as number) < 0 ||
      typeof value.ready !== 'boolean'
    )
      return null
    return {
      available: true,
      protocol: value.protocol,
      epoch: value.epoch,
      inputRevision: value.inputRevision,
      ready: value.ready,
      currentThreadId: value.threadId,
      operations: ['submit'],
    }
  } catch {
    return null
  }
}

export async function nativeAdminApply(
  binding: NativeBinding,
  request: AdminRequest,
): Promise<Metadata> {
  const { kind, requestKey, generation, expectedThreadId, expectedEpoch, expectedInputRevision } =
    request
  const pins = {
    kind,
    requestKey,
    generation,
    expectedThreadId,
    expectedEpoch,
    expectedInputRevision,
  }
  const uncertain = { ...pins, applied: null, reason: 'native_receipt_unqualified' }
  if (kind === 'clear')
    return { ...pins, applied: false, reason: 'native_clear_atomic_handoff_unavailable' }
  if (!expectedEpoch || expectedInputRevision === undefined)
    return { ...pins, applied: false, reason: 'native_pins_required' }
  const params = {
    requestKey,
    expectedEpoch,
    expectedThreadId,
    expectedInputRevision,
    operation: { kind, text: request.text },
  }
  const digest = createHash('sha256').update(JSON.stringify(params)).digest('hex')
  try {
    const value = await rpc(binding, { method: 'apply', params })
    if (
      !object(value) ||
      value.requestDigest !== digest ||
      value.requestKey !== requestKey ||
      value.expectedEpoch !== expectedEpoch ||
      value.expectedThreadId !== expectedThreadId ||
      value.expectedInputRevision !== expectedInputRevision ||
      typeof value.reason !== 'string' ||
      !KEY.test(value.reason)
    )
      return uncertain
    if (value.state === 'rejected') return { ...pins, applied: false, reason: value.reason }
    if (value.state === 'uncertain') return { ...pins, applied: null, reason: value.reason }
    if (
      value.state !== 'applied' ||
      value.reason !== 'native_accepted' ||
      value.oldThreadId !== expectedThreadId ||
      value.inputRevision !== expectedInputRevision ||
      typeof value.newThreadId !== 'string' ||
      !UUID.test(value.newThreadId)
    )
      return uncertain
    if (kind === 'submit') {
      const contentDigest = createHash('sha256').update(request.text).digest('hex')
      if (
        value.newThreadId !== expectedThreadId ||
        value.contentDigest !== contentDigest ||
        typeof value.acceptedTurnId !== 'string' ||
        !KEY.test(value.acceptedTurnId) ||
        typeof value.clientUserMessageId !== 'string' ||
        !UUID.test(value.clientUserMessageId)
      )
        return uncertain
      return {
        ...pins,
        applied: true,
        reason: value.reason,
        newThreadId: value.newThreadId,
        acceptedTurnId: value.acceptedTurnId,
        clientUserMessageId: value.clientUserMessageId,
        contentDigest,
      }
    }
    return uncertain
  } catch {
    return { ...pins, applied: null, reason: 'native_transport_uncertain' }
  }
}
