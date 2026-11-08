// Full peers keep writable mirrors; workers use granted copies and send writes to a full peer.
import { join } from 'node:path'
import {
  type Login,
  type LoginCaller,
  type LoginEdit,
  LoginError,
  LoginStore,
  type LoginUnavailable,
  loginMachine,
  loginPolicy,
} from './logins'
import { pushLoginGrants } from './logins-delivery'
import { requestLoginWire } from './logins-wire'
import { readSettings } from './settings'
import { readPins } from './trust'

type Operation =
  | 'list'
  | 'show'
  | 'value'
  | 'set'
  | 'grant'
  | 'remove'
  | 'assign'
  | 'assignments'
  | 'audit'
  | 'resolveLab'
  | 'patchLab'
  | 'catalog'
  | 'allow'
  | 'edit'
interface LoginRequest {
  operation: Operation
  args: unknown[]
  caller: LoginCaller
}
type View = Login & { state: string }
const reads = new Set<Operation>([
  'list',
  'catalog',
  'show',
  'value',
  'resolveLab',
  'assignments',
  'audit',
])
export function loginPeers(env = process.env) {
  const settings = readSettings(env, '')
  const full = settings
    ? readPins(settings.allowlist).some(
        (pin) => pin.name === settings.machine && pin.role === 'full',
      )
    : true
  const pins = settings ? readPins(settings.allowlist) : []
  const peers =
    settings?.peers
      .filter((peer) => pins.some((pin) => pin.name === peer.name && pin.role === 'full'))
      .sort((a, b) => {
        const rank = (name: string) => {
          const index = loginPolicy.writePeerPreference.indexOf(name)
          return index < 0 ? loginPolicy.writePeerPreference.length : index
        }
        return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)
      }) || []
  return { settings, full, peers }
}
function perform(store: LoginStore, request: LoginRequest): unknown {
  const { operation, args, caller } = request
  switch (operation) {
    case 'list':
      return store.list(caller).map((entry) => ({ ...entry, state: store.state(entry) }))
    case 'catalog':
      return store
        .catalog(caller)
        .map((entry) => ('available' in entry ? entry : { ...entry, state: store.state(entry) }))
    case 'allow':
      return store.allow(args[0] as string, args[1] as Parameters<LoginStore['allow']>[1], caller)
    case 'edit':
      return store.edit(args[0] as string, args[1] as LoginEdit, caller)
    case 'show':
      return store.show(args[0] as string, caller)
    case 'value':
      return store
        .value(args[0] as string, caller, typeof args[1] === 'string' ? args[1] : undefined)
        .toString('base64')
    case 'set':
      return store.set(
        args[0] as string,
        args[1] as string,
        args[2] as Partial<Login>,
        caller,
        args[3] === true,
      )
    case 'grant':
      return store.grant(
        args[0] as string,
        args[1] as 'machine' | 'role',
        args[2] as string,
        args[3] === true,
        caller,
      )
    case 'remove':
      return store.remove(args[0] as string, caller, args[1] === true)
    case 'assign':
      return store.assign(args[0] as string, args[1] as string[], caller)
    case 'assignments':
      return store.assignments(caller)
    case 'audit':
      return store.audit(caller)
    case 'resolveLab':
      return store.resolveLab(args[0] as string, args[1], caller)
    case 'patchLab':
      return store.patchLab(
        args[0] as string,
        args[1] as string,
        args[2] as Parameters<LoginStore['patchLab']>[2],
        caller,
      )
    default:
      throw new LoginError('Unknown login operation')
  }
}
/** Runs only on the authority; the approved fleet channel carries the original caller metadata. */
export async function loginRpc(input: string, env = process.env): Promise<string> {
  try {
    const request = JSON.parse(input) as LoginRequest
    if (
      !request ||
      !request.caller ||
      typeof request.caller.role !== 'string' ||
      typeof request.caller.machine !== 'string' ||
      !Array.isArray(request.args)
    )
      throw new LoginError('Invalid login operation')
    const authority = loginPeers(env)
    if (!authority.full) throw new LoginError('Only a full peer accepts login writes')
    const result = perform(new LoginStore(env), request)
    // Machine reads never push snapshots; their collapsed records ride along with the next sync.
    const reveal =
      request.operation === 'value' &&
      loginPolicy.auditExplicitActions.includes(String(request.args[1]))
    if ((!reads.has(request.operation) || reveal) && authority.settings) {
      // Each snapshot also updates target assignments. Disconnected peers catch up on their next link.
      const settings = authority.settings
      const deliveries = await Promise.allSettled(
        settings.peers.map((peer) => pushLoginGrants(settings, peer.name, env)),
      )
      if (deliveries.some((d) => d.status === 'rejected'))
        return JSON.stringify({
          ok: true,
          value: result ?? null,
          warning: 'Saved here. An offline machine will sync when it reconnects.',
        })
    }
    return JSON.stringify({ ok: true, value: result ?? null })
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error:
        error instanceof LoginError ? error.message : 'Logins could not complete the operation',
    })
  }
}
export class LoginClient {
  readonly local: LoginStore
  warning = ''
  offline = false
  constructor(readonly env = process.env) {
    this.local = new LoginStore(env)
  }
  private async request<T>(operation: Operation, args: unknown[], caller: LoginCaller): Promise<T> {
    const authority = loginPeers(this.env),
      request: LoginRequest = { operation, args, caller }
    this.warning = ''
    this.offline = false
    if (authority.full) {
      const response = JSON.parse(await loginRpc(JSON.stringify(request), this.env)) as {
        ok: boolean
        value: T
        error?: string
        warning?: string
      }
      if (!response.ok) throw new LoginError(response.error || 'Logins refused the operation')
      this.warning = response.warning || ''
      return response.value
    }
    let output: string | undefined
    for (const peer of authority.peers) {
      try {
        output = await requestLoginWire(
          join(authority.settings?.peerRoot || '', peer.name, 'logins.sock'),
          JSON.stringify(request),
        )
        break
      } catch {
        /* A different full peer can still be live. */
      }
    }
    if (output === undefined) {
      this.offline = true
      if (!reads.has(operation))
        throw new LoginError(
          'No full Aico is reachable. Saved copies are read-only until one reconnects.',
        )
      this.warning = 'No full Aico is reachable. Showing saved copies; edits need a connection.'
      return perform(this.local, request) as T
    }
    let response: { ok: boolean; value: T; error?: string; warning?: string }
    try {
      response = JSON.parse(output)
    } catch {
      throw new LoginError('The full peer returned an unreadable login response')
    }
    if (!response.ok) throw new LoginError(response.error || 'Logins refused the operation')
    this.warning = response.warning || ''
    return response.value
  }
  list(caller: LoginCaller) {
    return this.request<View[]>('list', [], caller)
  }
  /** Every login an agent could be given: usable ones in full, the rest with what is missing. */
  catalog(caller: LoginCaller) {
    return this.request<(View | LoginUnavailable)[]>('catalog', [], caller)
  }
  allow(name: string, subject: Parameters<LoginStore['allow']>[1], caller: LoginCaller) {
    return this.request<ReturnType<LoginStore['allow']>>('allow', [name, subject], caller)
  }
  edit(name: string, patch: LoginEdit, caller: LoginCaller) {
    return this.request<Login>('edit', [name, patch], caller)
  }
  show(name: string, caller: LoginCaller) {
    return this.request<Login>('show', [name], caller)
  }
  async value(name: string, caller: LoginCaller, action?: string) {
    return Buffer.from(await this.request<string>('value', [name, action], caller), 'base64')
  }
  set(
    name: string,
    value: string | Buffer,
    metadata: Partial<Login>,
    caller: LoginCaller,
    replace = false,
  ) {
    return this.request<Login>('set', [name, value.toString(), metadata, replace], caller)
  }
  grant(
    name: string,
    type: 'machine' | 'role',
    value: string,
    granted: boolean,
    caller: LoginCaller,
  ) {
    return this.request<Login>('grant', [name, type, value, granted], caller)
  }
  remove(name: string, caller: LoginCaller, confirmed: boolean) {
    return this.request<null>('remove', [name, confirmed], caller)
  }
  assign(session: string, targets: string[], caller: LoginCaller) {
    return this.request<null>('assign', [session, targets], caller)
  }
  assignments(caller: LoginCaller) {
    return this.request<Record<string, string[]>>('assignments', [], caller)
  }
  audit(caller: LoginCaller) {
    return this.request<ReturnType<LoginStore['audit']>>('audit', [], caller)
  }
  resolveLab(target: string, selection: unknown, caller: LoginCaller) {
    return this.request<ReturnType<LoginStore['resolveLab']>>(
      'resolveLab',
      [target, selection],
      caller,
    )
  }
  patchLab(
    target: string,
    actor: string,
    patch: Parameters<LoginStore['patchLab']>[2],
    caller: LoginCaller,
  ) {
    return this.request<Login>('patchLab', [target, actor, patch], caller)
  }
}

export async function loginPeerRpc(
  input: string,
  peer: string,
  role: 'full' | 'worker',
  env: NodeJS.ProcessEnv,
  settings: import('./settings').FleetSettings,
  localFull?: boolean,
): Promise<string> {
  try {
    const request = JSON.parse(input) as LoginRequest & {
      snapshot?: import('./logins').LoginSnapshot
    }
    if ((request.operation as string) === 'sync') {
      if (role !== 'full' || !request.snapshot)
        throw new LoginError('Only full peers send login snapshots')
      const full =
        localFull ??
        readPins(settings.allowlist).some(
          (pin) => pin.name === settings.machine && pin.role === 'full',
        )
      if (request.snapshot.full !== full)
        throw new LoginError('Login snapshot does not match this peer role')
      request.snapshot.source = peer
      const changed = new LoginStore(env).mergeSnapshot(request.snapshot, settings.machine)
      if (changed && full)
        await Promise.allSettled(
          settings.peers
            .filter((other) => other.name !== peer)
            .map((other) => pushLoginGrants(settings, other.name, env)),
        )
      return JSON.stringify({ ok: true, value: true })
    }
    if (localFull === false) throw new LoginError('Only a full peer accepts login operations')
    if (role === 'worker') {
      if (!request.caller) throw new LoginError('A login caller is required')
      request.caller.owner = false
      request.caller.machine = peer
    }
    return loginRpc(JSON.stringify(request), env)
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error instanceof LoginError ? error.message : 'Invalid login operation',
    })
  }
}
