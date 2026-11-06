// Metadata and values share the existing secrets folder. Only explicit use reads values.
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import policy from '../data/logins-policy.json' with { type: 'json' }
import type { ToolSecret } from './secret-files'
import {
  parseToolSecrets,
  privateFile,
  secretsDir,
  toolLoginsFile,
  writePrivate,
} from './secret-files'
import { fleetFile } from './settings'

export const LOGIN_KINDS = ['tool login', 'API key', 'password', 'backup key', 'lab login'] as const
export type LoginKind = (typeof LOGIN_KINDS)[number]
export interface Login {
  revision?: LoginRevision
  replicaFrom?: string
  name: string
  file: string
  kind: LoginKind
  notes: string
  machines: string[]
  roles: string[]
  deniedRoles?: string[]
  created: string
  rotated: string | null
  lastUsed: string | null
  tool?: ToolSecret
  provider?: string
  lab?: { target: string; actor: string; kind: string; expires_at: string | null; fields: string[] }
  verifierOnly?: boolean
  source?: string
}
export interface LoginCaller {
  role: string
  machine: string
  session?: string
  owner?: boolean
}
export interface LoginAudit {
  id?: string
  at: string
  action: string
  name: string
  actor: string
}
interface Index {
  version: 1
  entries: Login[]
  assignments: Record<string, string[]>
  audit: LoginAudit[]
  replicaRevocations?: Record<string, LoginRevision>
  clock?: number
  tombstones?: Record<string, LoginRevision>
  assignmentVersions?: Record<string, { revision: LoginRevision; targets: string[] }>
}
export interface LoginRevision {
  time: number
  node: string
}
export interface LoginSnapshot {
  source: string
  full: boolean
  entries: { entry: Login; value: string }[]
  tombstones: Record<string, LoginRevision>
  revocations?: Record<string, LoginRevision>
  assignments: Record<string, { revision: LoginRevision; targets: string[] }>
  audit: LoginAudit[]
}
export function compareLoginRevision(a?: LoginRevision, b?: LoginRevision) {
  return (a?.time || 0) - (b?.time || 0) || (a?.node || '').localeCompare(b?.node || '')
}
export class LoginError extends Error {}
export const loginMachine = () => hostname().split('.')[0].toLowerCase()
export function loginName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === 'index.json' ||
    (typeof value === 'string' && policy.localFiles.includes(value)) ||
    !/^[a-z0-9_][a-z0-9_.-]{0,179}$/.test(value)
  )
    throw new LoginError('Invalid login name')
  return value
}
const field = /^[A-Za-z_][A-Za-z0-9_]*$/
export function labIdentity(target: string, actor: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(target) || !/^[a-z0-9][a-z0-9._-]{0,49}$/.test(actor))
    throw new LoginError('Invalid lab target or actor')
  return { name: `_lab_${target}--${actor}`, reference: `secret://lab/${target}/${actor}` }
}
export function labPayload(value: string, target: string, actor: string, allowExpired = false) {
  let data: unknown
  try {
    data = JSON.parse(value)
  } catch {
    throw new LoginError('Invalid lab login JSON')
  }
  const p = data as Record<string, unknown> | null
  const identity = labIdentity(target, actor)
  if (
    !p ||
    p.schema_version !== 1 ||
    p.reference !== identity.reference ||
    !['synthetic', 'temporary', 'account'].includes(String(p.kind)) ||
    !p.values ||
    typeof p.values !== 'object' ||
    Array.isArray(p.values)
  )
    throw new LoginError('Invalid lab login bundle')
  const expiry = p.expires_at
  if (
    expiry !== null &&
    (typeof expiry !== 'string' ||
      !Number.isFinite(Date.parse(expiry)) ||
      !/(Z|[+-]\d\d:\d\d)$/.test(expiry))
  )
    throw new LoginError('Invalid lab login expiry')
  if (p.kind === 'temporary' && !expiry) throw new LoginError('Temporary lab logins need an expiry')
  if (!allowExpired && expiry && Date.parse(String(expiry)) <= Date.now())
    throw new LoginError('Lab login expired')
  const values = p.values as Record<string, string>
  if (
    !Object.keys(values).length ||
    Object.entries(values).some(([key, val]) => !field.test(key) || typeof val !== 'string' || !val)
  )
    throw new LoginError('Invalid lab login fields')
  return {
    schema_version: 1,
    reference: identity.reference,
    kind: String(p.kind),
    expires_at: expiry as string | null,
    values,
  }
}
export class LoginStore {
  readonly folder: string
  readonly path: string
  constructor(
    readonly env: NodeJS.ProcessEnv = process.env,
    readonly now = () => new Date().toISOString(),
    readonly node = loginMachine(),
  ) {
    this.folder = secretsDir(env)
    this.path = join(this.folder, 'index.json')
    if (!existsSync(this.path)) this.discover()
  }
  private read(): Index {
    if (!existsSync(this.path)) return { version: 1, entries: [], assignments: {}, audit: [] }
    try {
      const data = JSON.parse(privateFile(this.path).toString()) as Index
      if (
        data.version !== 1 ||
        !Array.isArray(data.entries) ||
        !data.assignments ||
        !Array.isArray(data.audit)
      )
        throw 0
      data.entries = data.entries.filter((entry) => !policy.localFiles.includes(entry.file))
      for (const entry of data.entries) {
        loginName(entry.name)
        loginName(entry.file)
        if (
          !LOGIN_KINDS.includes(entry.kind) ||
          !Array.isArray(entry.roles) ||
          !Array.isArray(entry.machines)
        )
          throw 0
      }
      data.clock ||= 0
      data.tombstones ||= {}
      data.assignmentVersions ||= {}
      for (const entry of data.entries)
        entry.revision ||= {
          time: Date.parse(entry.rotated || entry.created) || 0,
          node: this.node,
        }
      for (const [session, targets] of Object.entries(data.assignments))
        data.assignmentVersions[session] ||= { revision: { time: 0, node: this.node }, targets }
      return data
    } catch {
      throw new LoginError('Could not read the Logins index')
    }
  }
  /** Overridable through the environment; the policy file holds the defaults. */
  private limit(variable: string, fallback: number) {
    const value = Number(this.env[variable])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  /** Machine reads are capped by age and count so the index, and each full snapshot, stays small.
   * Changes and explicit reveals are kept apart under their own count cap, so reads never push
   * them out. */
  private trim(audit: LoginAudit[]): LoginAudit[] {
    const since =
      (Date.parse(this.now()) || Date.now()) -
      this.limit('AICO_LOGINS_AUDIT_MAX_DAYS', policy.auditMaxDays) * 86_400_000
    const max = this.limit('AICO_LOGINS_AUDIT_MAX_ENTRIES', policy.auditMaxEntries)
    const sorted = [...audit].sort((a, b) => a.at.localeCompare(b.at))
    const read = (event: LoginAudit) => policy.auditReadActions.includes(event.action)
    const kept = new Set([
      ...sorted.filter((event) => read(event) && !(Date.parse(event.at) < since)).slice(-max),
      ...sorted.filter((event) => !read(event)).slice(-max),
    ])
    return sorted.filter((event) => kept.has(event))
  }
  /** flock(2) on a descriptor this process holds: the kernel drops it if the process dies. */
  private change<T>(fn: (index: Index) => T, persist: () => boolean = () => true): T {
    mkdirSync(this.folder, { recursive: true, mode: 0o700 })
    const dir = lstatSync(this.folder)
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || dir.mode & 0o077)
      throw new LoginError('Secrets folder must be private')
    const fd = openSync(join(this.folder, '.index.flock'), 'a', 0o600)
    try {
      // The helper locks our open file description; the lock outlives the helper until we close fd.
      const held = spawnSync('flock', ['-x', '-w', String(policy.lockWaitSeconds), '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd],
      })
      if (held.error) throw new LoginError('Logins needs flock (util-linux) on this machine')
      if (held.status !== 0) throw new LoginError('Another Logins change is in progress')
      const index = this.read()
      const result = fn(index)
      if (persist()) {
        index.audit = this.trim(index.audit)
        writePrivate(this.path, JSON.stringify(index, null, 2))
      }
      return result
    } finally {
      closeSync(fd)
    }
  }
  /** Explicit actions always record; machine reads record once per actor, action and login per window. */
  private record(
    index: Index,
    caller: LoginCaller,
    action: string,
    name: string,
    collapse = false,
  ): boolean {
    const at = this.now(),
      actor = caller.session || (caller.owner ? 'owner' : caller.role)
    if (collapse && !policy.auditExplicitActions.includes(action)) {
      const since =
        (Date.parse(at) || Date.now()) -
        this.limit('AICO_LOGINS_AUDIT_COLLAPSE_SECONDS', policy.auditCollapseSeconds) * 1000
      for (let i = index.audit.length - 1; i >= 0; i--) {
        const event = index.audit[i]
        if (Date.parse(event.at) < since) break
        if (event.action === action && event.name === name && event.actor === actor) return false
      }
    }
    index.audit.push({ id: randomUUID(), at, action, name, actor })
    return true
  }
  private revision(index: Index): LoginRevision {
    index.clock = Math.max(index.clock || 0, Date.parse(this.now()) || 0) + 1
    return { time: index.clock, node: this.node }
  }
  private allowed(entry: Login, caller: LoginCaller, index = this.read(), toolRuntime = false) {
    if (caller.owner) return true
    if (policy.restrictedRoles.includes(caller.role)) {
      if (!entry.lab && !(toolRuntime && entry.tool)) return false
    }
    if (
      policy.restrictedTools.includes(entry.tool?.tool || entry.provider || '') &&
      policy.restrictedRoles.includes(caller.role)
    )
      return false
    if (
      entry.lab &&
      (!caller.session || !index.assignments[caller.session]?.includes(entry.lab.target))
    )
      return false
    return (
      entry.machines.includes(caller.machine) &&
      !entry.deniedRoles?.includes(caller.role) &&
      (entry.roles.includes('*') || entry.roles.includes(caller.role))
    )
  }
  private require(index: Index, name: string, caller: LoginCaller, toolRuntime = false) {
    const entry = index.entries.find((e) => e.name === loginName(name))
    if (!entry || !this.allowed(entry, caller, index, toolRuntime))
      throw new LoginError('Login unavailable for this role, machine or target')
    return entry
  }
  private owner(caller: LoginCaller) {
    if (!caller.owner) throw new LoginError('Only the owner can do this')
  }
  /** Index existing files without copying values. Legacy tool destinations become index metadata. */
  discover(): void {
    this.change((index) => {
      let tools: ToolSecret[] = []
      if (existsSync(toolLoginsFile(this.env))) {
        try {
          tools = parseToolSecrets(JSON.parse(privateFile(toolLoginsFile(this.env)).toString()))
        } catch {
          throw new LoginError('Could not read the tool login map')
        }
      }
      index.entries = index.entries.filter((entry) => !policy.localFiles.includes(entry.file))
      for (const name of readdirSync(this.folder).filter(
        (name) =>
          !name.startsWith('.') && name !== 'index.json' && !policy.localFiles.includes(name),
      )) {
        if (index.entries.some((e) => e.file === name)) continue
        loginName(name)
        const stat = lstatSync(join(this.folder, name))
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
          throw new LoginError('A stored login file is not private')
        const tool = tools.find((t) => t.file === name)
        const lab = /^_lab_(.+)--([a-z0-9][a-z0-9._-]*)$/.exec(name)
        const bundle = lab
          ? labPayload(privateFile(join(this.folder, name)).toString(), lab[1], lab[2], true)
          : null
        index.entries.push({
          name,
          file: name,
          kind: lab
            ? 'lab login'
            : tool
              ? 'tool login'
              : name.includes('key')
                ? 'backup key'
                : 'API key',
          notes: name.endsWith('.sha256')
            ? 'Verifier only. Held on VM 180; issue a new token to rotate.'
            : '',
          machines: [loginMachine()],
          roles: ['*'],
          created: stat.birthtime.toISOString(),
          rotated: null,
          lastUsed: null,
          ...(tool ? { tool } : {}),
          ...(name.endsWith('.sha256') ? { verifierOnly: true } : {}),
          ...(bundle && lab
            ? {
                lab: {
                  target: lab[1],
                  actor: lab[2],
                  kind: bundle.kind,
                  expires_at: bundle.expires_at,
                  fields: Object.keys(bundle.values),
                },
              }
            : {}),
        })
      }
      let peers: { name: string; tools?: string[] }[] = []
      if (existsSync(fleetFile(this.env))) {
        try {
          peers = JSON.parse(privateFile(fleetFile(this.env)).toString()).peers || []
        } catch {
          throw new LoginError('Could not read machine tool grants')
        }
      }
      for (const tool of tools) {
        const existing = index.entries.find((e) => e.file === tool.file)
        if (existing) {
          existing.tool = tool
          existing.kind = 'tool login'
          for (const peer of peers.filter((p) => p.tools?.includes(tool.tool)))
            if (!existing.machines.includes(peer.name)) existing.machines.push(peer.name)
        } else
          index.entries.push({
            name: tool.file,
            file: tool.file,
            kind: 'tool login',
            tool,
            notes: '',
            machines: [
              loginMachine(),
              ...peers.filter((p) => p.tools?.includes(tool.tool)).map((p) => p.name),
            ],
            roles: ['*'],
            created: this.now(),
            rotated: null,
            lastUsed: null,
          })
      }
    })
    if (existsSync(toolLoginsFile(this.env))) unlinkSync(toolLoginsFile(this.env))
  }
  list(caller?: LoginCaller): Login[] {
    if (!existsSync(this.path)) this.discover()
    const index = this.read()
    return index.entries
      .filter((entry) => !caller || this.allowed(entry, caller, index))
      .map((entry) => structuredClone(entry))
  }
  show(name: string, caller: LoginCaller): Login {
    return structuredClone(this.require(this.read(), name, caller))
  }
  state(entry: Login) {
    if (entry.lab?.expires_at && Date.parse(entry.lab.expires_at) <= Date.now()) return 'Expired'
    return !existsSync(join(this.folder, entry.file))
      ? entry.tool
        ? 'Needs sign-in'
        : 'Unavailable'
      : entry.verifierOnly
        ? 'Held on VM 180'
        : entry.lastUsed
          ? 'In use'
          : 'Unused'
  }
  set(
    name: string,
    value: string | Buffer,
    metadata: Partial<Login>,
    caller: LoginCaller,
    replace = false,
  ): Login {
    loginName(name)
    if (!value.length || Buffer.byteLength(value) > policy.maxValueBytes)
      throw new LoginError('Login value is empty or too large')
    return this.change((index) => this.write(index, name, value, metadata, caller, replace))
  }
  private write(
    index: Index,
    name: string,
    value: string | Buffer,
    metadata: Partial<Login>,
    caller: LoginCaller,
    replace: boolean,
  ): Login {
    const old = index.entries.find((entry) => entry.name === name)
    if (old && !replace) throw new LoginError('Login exists; use rotate to replace it')
    if (!old && replace) throw new LoginError('Login unavailable; add it before rotating it')
    if (
      !caller.owner &&
      (old
        ? !this.allowed(old, caller, index)
        : metadata.lab
          ? !caller.session || !index.assignments[caller.session]?.includes(metadata.lab.target)
          : policy.restrictedRoles.includes(caller.role))
    )
      throw new LoginError('Login unavailable for this role, machine or target')
    if (metadata.tool) {
      parseToolSecrets([metadata.tool])
      if (metadata.tool.file !== name)
        throw new LoginError('Tool login destination does not match its name')
    }
    if (
      metadata.notes !== undefined &&
      (typeof metadata.notes !== 'string' || metadata.notes.length > 4000)
    )
      throw new LoginError('Invalid login notes')
    if (
      [metadata.roles, metadata.machines, metadata.deniedRoles].some(
        (items) =>
          items !== undefined &&
          (!Array.isArray(items) ||
            items.some(
              (item) => typeof item !== 'string' || !/^[A-Za-z0-9_.*-]{1,128}$/.test(item),
            )),
      )
    )
      throw new LoginError('Invalid login grants')
    if (old?.verifierOnly) throw new LoginError('Issue a new token in the owning app')
    const kind = old?.kind || metadata.kind || 'API key'
    if (kind === 'lab login' && !old?.lab && !metadata.lab)
      throw new LoginError('Use lab enroll for a scoped lab login')
    if (!LOGIN_KINDS.includes(kind)) throw new LoginError('Invalid login kind')
    const entry: Login = {
      revision: this.revision(index),
      name,
      file: old?.file || name,
      kind,
      notes: metadata.notes ?? old?.notes ?? '',
      machines:
        caller.owner && metadata.machines ? metadata.machines : old?.machines || [caller.machine],
      roles: caller.owner && metadata.roles ? metadata.roles : old?.roles || ['*'],
      deniedRoles:
        caller.owner && metadata.deniedRoles ? metadata.deniedRoles : old?.deniedRoles || [],
      created: old?.created || metadata.created || this.now(),
      rotated: old ? this.now() : null,
      lastUsed: old?.lastUsed || null,
      ...(old?.tool || metadata.tool ? { tool: old?.tool || metadata.tool } : {}),
      ...(metadata.provider || old?.provider
        ? { provider: metadata.provider || old?.provider }
        : {}),
      ...(metadata.source || old?.source ? { source: metadata.source || old?.source } : {}),
      ...(metadata.lab || old?.lab ? { lab: metadata.lab || old?.lab } : {}),
    }
    if (entry.lab) {
      const p = labPayload(value.toString(), entry.lab.target, entry.lab.actor)
      if (old?.lab) {
        const previous = labPayload(
          privateFile(join(this.folder, old.file)).toString(),
          old.lab.target,
          old.lab.actor,
          true,
        )
        if (p.kind !== previous.kind) throw new LoginError('A lab replacement keeps its kind')
        if (
          previous.values.login_url &&
          p.values.login_url &&
          !p.values.password &&
          new URL(previous.values.login_url).origin !== new URL(p.values.login_url).origin
        )
          throw new LoginError('Changing the site needs the password again')
      }
      if (name !== labIdentity(entry.lab.target, entry.lab.actor).name)
        throw new LoginError('Lab login identity mismatch')
      entry.lab = {
        target: entry.lab.target,
        actor: entry.lab.actor,
        kind: p.kind,
        expires_at: p.expires_at,
        fields: Object.keys(p.values),
      }
    }
    writePrivate(join(this.folder, entry.file), value)
    if (entry.tool?.authFile) writePrivate(join(this.env.HOME || '', entry.tool.authFile), value)
    index.entries = [...index.entries.filter((e) => e.name !== name), entry]
    if (index.tombstones) delete index.tombstones[name]
    this.record(index, caller, old ? 'rotate' : 'set', name)
    return entry
  }

  /** A read rewrites the index only when it adds an activity record; it never syncs by itself. */
  value(name: string, caller: LoginCaller, action = 'use'): Buffer {
    let recorded = false
    return this.change(
      (index) => {
        const entry = this.require(index, name, caller)
        if (entry.verifierOnly) throw new LoginError('Only a verifier is stored here')
        if (entry.lab && !caller.owner)
          throw new LoginError('Use lab run for a scoped descriptor handoff')
        const value = privateFile(join(this.folder, entry.file))
        recorded = this.record(index, caller, action, name, true)
        if (recorded) entry.lastUsed = this.now()
        return value
      },
      () => recorded,
    )
  }
  /** Existing tool launcher only; raw retrieval keeps the stricter caller scope. */
  toolValue(name: string, caller: LoginCaller): Buffer {
    let recorded = false
    return this.change(
      (index) => {
        const entry = this.require(index, name, caller, true)
        if (!entry.tool || entry.verifierOnly) throw new LoginError('Tool login unavailable')
        const value = privateFile(join(this.folder, entry.file))
        recorded = this.record(index, caller, 'tool use', name, true)
        if (recorded) entry.lastUsed = this.now()
        return value
      },
      () => recorded,
    )
  }
  grant(
    name: string,
    type: 'machine' | 'role',
    value: string,
    granted: boolean,
    caller: LoginCaller,
  ) {
    this.owner(caller)
    if (!/^[A-Za-z0-9_.*-]{1,128}$/.test(value)) throw new LoginError('Invalid grant')
    return this.change((index) => {
      const entry = this.require(index, name, caller)
      entry.revision = this.revision(index)
      const key = type === 'machine' ? 'machines' : 'roles'
      entry[key] = [
        ...new Set([...entry[key].filter((item) => item !== value), ...(granted ? [value] : [])]),
      ]
      if (type === 'role') {
        entry.deniedRoles = (entry.deniedRoles || []).filter((role) => role !== value)
        if (!granted && entry.roles.includes('*')) entry.deniedRoles.push(value)
      }
      this.record(index, caller, granted ? 'grant' : 'revoke', name)
      return entry
    })
  }
  remove(name: string, caller: LoginCaller, confirmed: boolean) {
    this.owner(caller)
    if (!confirmed) throw new LoginError('Confirm removal with the login name')
    this.change((index) => {
      const entry = this.require(index, name, caller)
      if (existsSync(join(this.folder, entry.file))) unlinkSync(join(this.folder, entry.file))
      if (entry.tool?.authFile && existsSync(join(this.env.HOME || '', entry.tool.authFile)))
        unlinkSync(join(this.env.HOME || '', entry.tool.authFile))
      index.entries = index.entries.filter((e) => e.name !== name)
      index.tombstones ||= {}
      index.tombstones[name] = this.revision(index)
      this.record(index, caller, 'remove', name)
    })
  }
  assignments(caller: LoginCaller) {
    if (!caller.owner && caller.role !== 'coordinator')
      throw new LoginError('Only a coordinator or the owner can manage lab assignments')
    return this.read().assignments
  }
  assign(session: string, targets: string[], caller: LoginCaller) {
    if (!caller.owner && caller.role !== 'coordinator')
      throw new LoginError('Only a coordinator or the owner can manage lab assignments')
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session)) throw new LoginError('Invalid session')
    for (const target of targets) labIdentity(target, 'default')
    this.change((index) => {
      index.assignments[session] = [...new Set(targets)]
      index.assignmentVersions ||= {}
      index.assignmentVersions[session] = {
        targets: [...new Set(targets)],
        revision: this.revision(index),
      }
      this.record(index, caller, 'assign', session)
    })
  }
  audit(caller: LoginCaller) {
    this.owner(caller)
    return this.trim(this.read().audit)
  }
  snapshot(machine: string, full: boolean): LoginSnapshot {
    const index = this.read()
    const entries = index.entries.filter(
      (entry) =>
        !policy.localFiles.includes(entry.file) &&
        (full || (!entry.verifierOnly && entry.machines.includes(machine))),
    )
    const targets = new Set(entries.flatMap((entry) => (entry.lab ? [entry.lab.target] : [])))
    return {
      source: this.node,
      full,
      entries: entries
        .filter((entry) => existsSync(join(this.folder, entry.file)))
        .map((entry) => ({ entry, value: privateFile(join(this.folder, entry.file)).toString() })),
      tombstones: full ? index.tombstones || {} : {},
      revocations: full
        ? {}
        : Object.fromEntries([
            ...index.entries
              .filter((entry) => !entry.machines.includes(machine))
              .map((entry) => [
                createHash('sha256').update(entry.name).digest('hex'),
                entry.revision,
              ]),
            ...Object.entries(index.tombstones || {}).map(([name, revision]) => [
              createHash('sha256').update(name).digest('hex'),
              revision,
            ]),
          ]),
      assignments: Object.fromEntries(
        Object.entries(index.assignmentVersions || {}).map(([session, item]) => [
          session,
          full
            ? item
            : {
                revision:
                  [
                    item.revision,
                    ...index.entries
                      .filter((entry) => entry.lab && item.targets.includes(entry.lab.target))
                      .flatMap((entry) => (entry.revision ? [entry.revision] : [])),
                  ]
                    .sort(compareLoginRevision)
                    .at(-1) || item.revision,
                targets: item.targets.filter((target) => targets.has(target)),
              },
        ]),
      ),
      audit: this.trim(
        full
          ? index.audit
          : index.audit.filter((event) => entries.some((entry) => entry.name === event.name)),
      ),
    }
  }
  mergeSnapshot(snapshot: LoginSnapshot, machine = loginMachine()): boolean {
    const version = (v: LoginRevision | undefined) =>
      !!v &&
      Number.isSafeInteger(v.time) &&
      v.time >= 0 &&
      typeof v.node === 'string' &&
      /^[a-zA-Z0-9_.-]{1,128}$/.test(v.node)
    if (
      !snapshot ||
      typeof snapshot.source !== 'string' ||
      typeof snapshot.full !== 'boolean' ||
      !Array.isArray(snapshot.entries) ||
      !snapshot.tombstones ||
      !snapshot.assignments ||
      !Array.isArray(snapshot.audit)
    )
      throw new LoginError('Invalid login snapshot')
    const seen = new Set<string>()
    for (const { entry, value } of snapshot.entries) {
      loginName(entry?.name)
      loginName(entry?.file)
      if (
        seen.has(entry.name) ||
        entry.name !== entry.file ||
        policy.localFiles.includes(entry.file) ||
        !version(entry.revision) ||
        !LOGIN_KINDS.includes(entry.kind) ||
        typeof value !== 'string' ||
        !value.length ||
        Buffer.byteLength(value) > policy.maxValueBytes ||
        !Array.isArray(entry.machines) ||
        !Array.isArray(entry.roles)
      )
        throw new LoginError('Invalid login snapshot')
      if (!snapshot.full && !entry.machines.includes(machine))
        throw new LoginError('Login snapshot is not granted to this machine')
      if (entry.tool) {
        parseToolSecrets([entry.tool])
        if (entry.tool.file !== entry.name)
          throw new LoginError('Tool login destination does not match its name')
      }
      if (entry.lab) {
        labPayload(value, entry.lab.target, entry.lab.actor, true)
        if (entry.name !== labIdentity(entry.lab.target, entry.lab.actor).name)
          throw new LoginError('Lab login identity mismatch')
      }
      seen.add(entry.name)
    }
    for (const [name, revision] of Object.entries(snapshot.tombstones)) {
      loginName(name)
      if (!version(revision)) throw new LoginError('Invalid login tombstone')
    }
    for (const [session, item] of Object.entries(snapshot.assignments)) {
      if (
        !/^[a-zA-Z0-9_-]{1,100}$/.test(session) ||
        !item ||
        !version(item.revision) ||
        !Array.isArray(item.targets)
      )
        throw new LoginError('Invalid lab assignment snapshot')
      for (const target of item.targets) labIdentity(target, 'default')
    }
    if (
      snapshot.audit.some(
        (event) =>
          !event ||
          typeof event.at !== 'string' ||
          typeof event.action !== 'string' ||
          typeof event.name !== 'string' ||
          typeof event.actor !== 'string',
      )
    )
      throw new LoginError('Invalid login activity snapshot')
    for (const [hash, revision] of Object.entries(snapshot.revocations || {}))
      if (!/^[a-f0-9]{64}$/.test(hash) || !version(revision))
        throw new LoginError('Invalid replica revocation')
    let changed = false
    return this.change((index) => {
      index.tombstones ||= {}
      index.replicaRevocations ||= {}
      index.assignmentVersions ||= {}
      const discard = (entry: Login) => {
        changed = true
        if (existsSync(join(this.folder, entry.file))) unlinkSync(join(this.folder, entry.file))
        if (entry.tool?.authFile && existsSync(join(this.env.HOME || '', entry.tool.authFile)))
          unlinkSync(join(this.env.HOME || '', entry.tool.authFile))
        index.entries = index.entries.filter((old) => old.name !== entry.name)
      }
      if (!snapshot.full)
        for (const [hash, revision] of Object.entries(snapshot.revocations || {})) {
          if (!/^[a-f0-9]{64}$/.test(hash) || !version(revision))
            throw new LoginError('Invalid replica revocation')
          if (compareLoginRevision(revision, index.replicaRevocations[hash]) > 0) {
            index.replicaRevocations[hash] = revision
            changed = true
          }
          const old = index.entries.find(
            (entry) => createHash('sha256').update(entry.name).digest('hex') === hash,
          )
          if (old && compareLoginRevision(revision, old.revision) >= 0) discard(old)
        }
      for (const [name, revision] of Object.entries(snapshot.tombstones)) {
        index.clock = Math.max(index.clock || 0, revision.time)
        const old = index.entries.find((entry) => entry.name === name)
        if (
          compareLoginRevision(revision, index.tombstones[name]) > 0 &&
          compareLoginRevision(revision, old?.revision) >= 0
        ) {
          if (old) discard(old)
          index.tombstones[name] = revision
          changed = true
        }
      }
      for (const { entry, value } of snapshot.entries) {
        const old = index.entries.find((old) => old.name === entry.name)
        index.clock = Math.max(index.clock || 0, entry.revision?.time || 0)
        if (
          compareLoginRevision(entry.revision, index.tombstones[entry.name]) <= 0 ||
          (!snapshot.full &&
            compareLoginRevision(
              entry.revision,
              index.replicaRevocations[createHash('sha256').update(entry.name).digest('hex')],
            ) <= 0)
        )
          continue
        if (compareLoginRevision(entry.revision, old?.revision) > 0) {
          changed = true
          writePrivate(join(this.folder, entry.file), value)
          if (entry.tool?.authFile)
            writePrivate(join(this.env.HOME || '', entry.tool.authFile), value)
          const next = { ...entry }
          if (snapshot.full) delete next.replicaFrom
          else next.replicaFrom = snapshot.source
          if (old?.lastUsed && (!next.lastUsed || old.lastUsed > next.lastUsed))
            next.lastUsed = old.lastUsed
          index.entries = [...index.entries.filter((old) => old.name !== entry.name), next]
        } else if (old && entry.lastUsed && (!old.lastUsed || entry.lastUsed > old.lastUsed)) {
          old.lastUsed = entry.lastUsed
          changed = true
        }
      }
      for (const [session, item] of Object.entries(snapshot.assignments)) {
        index.clock = Math.max(index.clock || 0, item.revision.time)
        if (compareLoginRevision(item.revision, index.assignmentVersions[session]?.revision) > 0) {
          changed = true
          index.assignmentVersions[session] = item
          index.assignments[session] = item.targets
        }
      }
      const key = (event: LoginAudit) => event.id || JSON.stringify(event)
      const before = new Set(this.trim(index.audit).map(key))
      const events = new Map(index.audit.map((event) => [key(event), event]))
      for (const event of snapshot.audit) if (!events.has(key(event))) events.set(key(event), event)
      // Only records that survive the cap count as news, so trimmed history never ping-pongs.
      index.audit = this.trim([...events.values()])
      if (index.audit.some((event) => !before.has(key(event)))) changed = true
      return changed
    })
  }
  syncTools(tools: ToolSecret[]) {
    this.discover()
    this.change((index) => {
      index.entries = index.entries.filter((e) => !e.tool || tools.some((t) => t.file === e.file))
      for (const tool of tools) {
        const entry = index.entries.find((e) => e.file === tool.file)
        if (entry) {
          entry.tool = tool
          entry.kind = 'tool login'
        } else {
          index.entries.push({
            name: tool.file,
            file: tool.file,
            kind: 'tool login',
            tool,
            notes: '',
            machines: [loginMachine()],
            roles: ['*'],
            created: this.now(),
            rotated: null,
            lastUsed: null,
          })
        }
      }
    })
  }
  patchLab(
    target: string,
    actor: string,
    patch: { set?: Record<string, string>; remove?: string[]; expires_at?: string | null },
    caller: LoginCaller,
  ) {
    return this.change((index) => {
      const name = labIdentity(target, actor).name,
        entry = this.require(index, name, caller)
      const old = labPayload(
        privateFile(join(this.folder, entry.file)).toString(),
        target,
        actor,
        true,
      )
      if (old.kind === 'temporary') throw new LoginError('Temporary lab logins cannot be edited')
      const set = patch.set || {},
        remove = patch.remove || []
      if (
        !Array.isArray(remove) ||
        remove.some(
          (key) => typeof key !== 'string' || key in set || !Object.hasOwn(old.values, key),
        )
      )
        throw new LoginError('Invalid fields to remove')
      const values = {
        ...Object.fromEntries(Object.entries(old.values).filter(([key]) => !remove.includes(key))),
        ...set,
      }
      if (old.kind === 'account' && (!values.username || !values.password))
        throw new LoginError('An account login keeps its username and password')
      if (
        old.values.login_url &&
        values.login_url &&
        !set.password &&
        new URL(old.values.login_url).origin !== new URL(values.login_url).origin
      )
        throw new LoginError('Changing the site needs the password again')
      const next = {
        ...old,
        expires_at: patch.expires_at === undefined ? old.expires_at : patch.expires_at,
        values,
      }
      return this.write(index, name, JSON.stringify(next), {}, caller, true)
    })
  }

  resolveLab(target: string, requests: unknown, caller: LoginCaller) {
    labIdentity(target, 'default')
    if (!Array.isArray(requests) || !requests.length)
      throw new LoginError('Lab selection must be a nonempty list')
    let recorded = false
    return this.change(
      (index) => {
        const seen = new Set<string>()
        const resolved = requests.map((item: unknown) => {
          const r = item as { reference?: unknown; fields?: unknown; optional_fields?: unknown }
          if (
            !r ||
            typeof r.reference !== 'string' ||
            !Array.isArray(r.fields) ||
            !r.fields.length ||
            (r.optional_fields !== undefined && !Array.isArray(r.optional_fields))
          )
            throw new LoginError('Invalid lab selection')
          const match = /^secret:\/\/lab\/([^/]+)\/([^/]+)$/.exec(r.reference)
          if (!match || match[1] !== target || seen.has(r.reference))
            throw new LoginError('Lab selection outside target or duplicated')
          seen.add(r.reference)
          const names = [...r.fields, ...(r.optional_fields || [])] as unknown[]
          if (
            new Set(names).size !== names.length ||
            names.some((n) => typeof n !== 'string' || !field.test(n))
          )
            throw new LoginError('Invalid lab field selection')
          const entry = this.require(index, labIdentity(target, match[2]).name, caller)
          const p = labPayload(
            privateFile(join(this.folder, entry.file)).toString(),
            target,
            match[2],
          )
          if (r.fields.some((name) => !Object.hasOwn(p.values, name)))
            throw new LoginError('A required lab field is unavailable')
          return {
            reference: r.reference,
            values: Object.fromEntries(
              (names as string[])
                .filter((name) => Object.hasOwn(p.values, name))
                .map((name) => [name, p.values[name]]),
            ),
          }
        })
        for (const item of resolved) {
          const actor = item.reference.split('/').pop() as string
          const name = labIdentity(target, actor).name
          if (this.record(index, caller, 'lab use', name, true)) {
            this.require(index, name, caller).lastUsed = this.now()
            recorded = true
          }
        }

        return { schema_version: 1, target, credentials: resolved }
      },
      () => recorded,
    )
  }
}

export { policy as loginPolicy }
