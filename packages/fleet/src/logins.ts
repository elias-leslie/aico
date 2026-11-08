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
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
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
  lab?: {
    target: string
    actor: string
    kind: string
    expires_at: string | null
    fields: string[]
    /** Account logins only: the two non-secret fields, kept here so the page and lists can show them. */
    username?: string
    login_url?: string
    /** Programs (absolute paths, compared by real path when used, so a `current` release link
     * follows deploys) this login's values may go to besides the shared adapters (policy
     * labPrograms); `lab run` refuses any other child. */
    programs?: string[]
  }
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
  /** What changed, in words (never a value): "role school-check", "login page https://...". */
  detail?: string
}
/** One thing that keeps a caller from a login, and the grant that fixes it. */
export interface LoginGap {
  /** policy: a restricted role never uses this kind of login; no grant opens it. */
  kind: 'machine' | 'role' | 'session' | 'policy'
  value: string
}
/** A login an agent may not use yet: what it is, what is missing and the one command that fixes it. */
export interface LoginUnavailable {
  name: string
  kind: LoginKind
  notes: string
  lab?: { target: string; actor: string; kind: string; login_url?: string }
  available: false
  missing: LoginGap[]
  fix: string
}
/** What an agent may change on a login it did not save: everything but the username and password. */
export interface LoginEdit {
  notes?: string
  kind?: LoginKind
  login_url?: string
  target?: string
  /** Add or drop a program (absolute path) `lab run` may hand this lab login's values to. */
  program?: string
  dropProgram?: string
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
/** The name an agent types for a login: an account or lab login's site name, else its stored name. */
export const loginLabel = (entry: Login) =>
  entry.lab && entry.lab.actor === 'default' ? entry.lab.target : entry.name
const gapText = (gap: LoginGap, entry: Login) =>
  gap.kind === 'machine'
    ? `machine ${gap.value} is not allowed`
    : gap.kind === 'session'
      ? `session ${gap.value} is not assigned target ${entry.lab?.target}`
      : gap.kind === 'role'
        ? `role ${gap.value} is not allowed`
        : `role ${gap.value} never uses this kind of login (policy)`
/** Backup keys, API keys, passwords and tool logins stay the owner's (owner decision 2026-11-08). */
const OWNER_CHANGES =
  'Only the owner changes this login, on the Logins page; ask with one tether ask create.'
const ACCOUNT_FIELDS_OWNERS =
  "An account login's username and password are the owner's (one plain ask); change its login page with aico logins edit"
/** The one command that gives CALLER what is missing, or the policy reason when no grant does. */
export function loginFix(entry: Login, gaps: LoginGap[], caller?: LoginCaller) {
  if (gaps.some((gap) => gap.kind === 'policy'))
    return 'No grant opens it for this role; use a lab login assigned to your session.'
  if (!entry.lab) return OWNER_CHANGES
  // Restricted roles never change access themselves: a coordinator assigns their lab targets.
  if (caller && policy.restrictedRoles.includes(caller.role))
    return `A coordinator runs: aico logins assign ${caller.session || 'SESSION'} --target ${entry.lab?.target || loginLabel(entry)}`
  return `aico logins allow ${loginLabel(entry)}`
}
export function unavailableText(entry: Login, caller: LoginCaller, gaps: LoginGap[]) {
  const what = gaps.map((gap) => gapText(gap, entry)).join('; ')
  const fix = loginFix(entry, gaps, caller)
  return `Login ${loginLabel(entry)} unavailable to ${caller.session ? `session ${caller.session}` : `role ${caller.role}`}: ${what}. ${
    fix.startsWith('aico ') ? `Fix it yourself (logged, no owner step): ${fix}` : fix
  }`
}
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
    detail?: string,
  ): boolean {
    const at = this.now(),
      actor = caller.session || (caller.owner ? 'owner' : caller.role)
    // Peers refuse longer details (mergeSnapshot), so a long login page URL is cut here.
    const text = detail && detail.length > 600 ? `${detail.slice(0, 599)}…` : detail
    if (collapse && !policy.auditExplicitActions.includes(action)) {
      const since =
        (Date.parse(at) || Date.now()) -
        this.limit('AICO_LOGINS_AUDIT_COLLAPSE_SECONDS', policy.auditCollapseSeconds) * 1000
      for (let i = index.audit.length - 1; i >= 0; i--) {
        const event = index.audit[i]
        if (Date.parse(event.at) < since) break
        if (
          event.action === action &&
          event.name === name &&
          event.actor === actor &&
          event.detail === text
        )
          return false
      }
    }
    index.audit.push({
      id: randomUUID(),
      at,
      action,
      name,
      actor,
      ...(text ? { detail: text } : {}),
    })
    return true
  }
  private revision(index: Index): LoginRevision {
    index.clock = Math.max(index.clock || 0, Date.parse(this.now()) || 0) + 1
    return { time: index.clock, node: this.node }
  }
  /** What keeps CALLER from ENTRY; empty when it may use it. Restricted roles stay out of the owner's
   * own logins by policy. A lab login opens through a session's target assignment or a role named on it;
   * an account login (the owner's own site login) also opens through "All roles" for unrestricted roles. */
  gaps(entry: Login, caller: LoginCaller, index = this.read(), toolRuntime = false): LoginGap[] {
    if (caller.owner) return []
    const restricted = policy.restrictedRoles.includes(caller.role)
    if (
      (restricted && !entry.lab && !(toolRuntime && entry.tool)) ||
      (restricted && policy.restrictedTools.includes(entry.tool?.tool || entry.provider || ''))
    )
      return [{ kind: 'policy', value: caller.role }]
    const gaps: LoginGap[] = []
    if (!entry.machines.includes(caller.machine))
      gaps.push({ kind: 'machine', value: caller.machine })
    const assigned =
      !!caller.session && !!index.assignments[caller.session]?.includes(entry.lab?.target || '')
    const named = entry.roles.includes(caller.role) && !entry.deniedRoles?.includes(caller.role)
    const everyone = entry.roles.includes('*') && !entry.deniedRoles?.includes(caller.role)
    const reached =
      !entry.lab || assigned || named || (entry.lab.kind === 'account' && everyone && !restricted)
    if (!reached && caller.session) gaps.push({ kind: 'session', value: caller.session })
    // A session's assignment still needs its role allowed, as "All roles" or by name.
    if (!named && (!reached ? !caller.session || !everyone : !everyone))
      gaps.push({ kind: 'role', value: caller.role })
    return gaps
  }
  private allowed(entry: Login, caller: LoginCaller, index = this.read(), toolRuntime = false) {
    return !this.gaps(entry, caller, index, toolRuntime).length
  }
  /** A login by its name, or by its lab target (the site name an account login is saved under). */
  private find(index: Index, name: string): Login | undefined {
    const exact = index.entries.find((e) => e.name === name)
    if (exact || typeof name !== 'string') return exact
    return this.siteNamed(index, name)
  }
  private siteNamed(index: Index, name: string): Login | undefined {
    const labs = index.entries.filter((e) => e.lab?.target === name)
    return labs.length === 1 ? labs[0] : labs.find((e) => e.lab?.actor === 'default')
  }
  private require(index: Index, name: string, caller: LoginCaller, toolRuntime = false) {
    const entry = this.find(index, loginName(name))
    if (!entry)
      throw new LoginError(`No login named ${name}. aico logins list shows every saved login.`)
    const gaps = this.gaps(entry, caller, index, toolRuntime)
    if (gaps.length) throw new LoginError(unavailableText(entry, caller, gaps))
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
              : name.includes('key') || /\.(ed25519|pub)$/.test(name)
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
  /** Every login an agent could be given, usable or not: the unusable ones by name, kind and site only,
   * with what is missing and the command that fixes it. A login a restricted role never uses is left out. */
  catalog(caller: LoginCaller): (Login | LoginUnavailable)[] {
    if (!existsSync(this.path)) this.discover()
    const index = this.read()
    return index.entries.flatMap((entry): (Login | LoginUnavailable)[] => {
      const gaps = this.gaps(entry, caller, index)
      if (!gaps.length) return [structuredClone(entry)]
      if (gaps.some((gap) => gap.kind === 'policy') || entry.verifierOnly) return []
      return [
        {
          name: entry.name,
          kind: entry.kind,
          notes: entry.notes,
          ...(entry.lab
            ? {
                lab: {
                  target: entry.lab.target,
                  actor: entry.lab.actor,
                  kind: entry.lab.kind,
                  ...(entry.lab.login_url ? { login_url: entry.lab.login_url } : {}),
                },
              }
            : {}),
          available: false,
          missing: gaps,
          fix: loginFix(entry, gaps, caller),
        },
      ]
    })
  }
  show(name: string, caller: LoginCaller): Login {
    return structuredClone(this.require(this.read(), name, caller))
  }
  /** What `aico logins show` prints: the login, its state and its latest changes, never a value. */
  details(name: string, caller: LoginCaller) {
    const index = this.read()
    const entry = this.require(index, name, caller)
    // Who did it is the owner's (audit); others see when and what changed.
    const activity = this.trim(index.audit)
      .filter((event) => event.name === entry.name)
      .slice(-policy.showActivity)
      .map((event) =>
        caller.owner
          ? event
          : {
              at: event.at,
              action: event.action,
              // A link's query, fragment or user part can hold a code; the rest says what changed.
              ...(event.detail
                ? { detail: event.detail.replace(/[?#]\S*/g, '').replace(/\/\/[^/\s]*@/g, '//') }
                : {}),
            },
      )
    return { ...structuredClone(entry), ...this.stateOf(entry), activity }
  }
  /** The state and the word `list` uses: Unused says no session has yet, not that one can't. */
  stateOf(entry: Login) {
    const state = this.state(entry)
    return { state, usable: state === 'In use' || state === 'Unused' }
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
    if (old && !replace)
      throw new LoginError(
        'A login with this name exists; Replace it on its row (aico logins rotate NAME)',
      )
    if (!old && replace) throw new LoginError('No login with this name; add it before replacing it')
    // Agents save site logins only: a replacement can't turn another login into one or into a tool's.
    if (
      !caller.owner &&
      (!(old ? old.lab : metadata.lab) || metadata.tool || metadata.provider || metadata.source)
    )
      throw new LoginError(`${name} is not a site login. ${OWNER_CHANGES}`)
    if (
      !caller.owner &&
      !old &&
      metadata.lab &&
      !(caller.session && index.assignments[caller.session]?.includes(metadata.lab.target))
    ) {
      // An unrestricted session that saves a new lab login gets its target (logged); a restricted one
      // is given targets by a coordinator.
      if (!caller.session || policy.restrictedRoles.includes(caller.role))
        throw new LoginError(
          `This session is not assigned lab target ${metadata.lab.target}. A coordinator runs: aico logins assign ${caller.session || 'SESSION'} --target ${metadata.lab.target}`,
        )
      this.addTarget(index, caller.session, metadata.lab.target)
      this.record(index, caller, 'allow', name, false, `session ${caller.session}`)
    }
    if (!caller.owner && old) {
      const gaps = this.gaps(old, caller, index)
      if (gaps.length) throw new LoginError(unavailableText(old, caller, gaps))
    }
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
    if (!LOGIN_KINDS.includes(kind))
      throw new LoginError(`Invalid login kind; use one of: ${LOGIN_KINDS.join(', ')}`)
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
          !caller.owner &&
          p.kind === 'account' &&
          ['username', 'password', 'login_url'].some(
            (key) => p.values[key] !== previous.values[key],
          )
        )
          throw new LoginError(ACCOUNT_FIELDS_OWNERS)
        if (
          previous.values.login_url &&
          p.values.login_url &&
          !p.values.password &&
          new URL(previous.values.login_url).origin !== new URL(p.values.login_url).origin
        )
          throw new LoginError('Changing the site needs the password again')
      }
      if (!old && !caller.owner && p.kind === 'account') throw new LoginError(ACCOUNT_FIELDS_OWNERS)
      if (name !== labIdentity(entry.lab.target, entry.lab.actor).name)
        throw new LoginError('Lab login identity mismatch')
      entry.lab = {
        target: entry.lab.target,
        actor: entry.lab.actor,
        kind: p.kind,
        expires_at: p.expires_at,
        fields: Object.keys(p.values),
        ...(p.kind === 'account' && p.values.username ? { username: p.values.username } : {}),
        ...(p.kind === 'account' && p.values.login_url ? { login_url: p.values.login_url } : {}),
        ...(old?.lab?.programs?.length ? { programs: old.lab.programs } : {}),
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
        recorded = this.record(index, caller, action, entry.name, true)
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
    this.selfService(caller)
    if (type === 'role') this.subjects(caller, value)
    if (!/^[A-Za-z0-9_.*-]{1,128}$/.test(value)) throw new LoginError('Invalid grant')
    return this.change((index) => {
      const entry = this.siteLogin(this.existing(index, name, caller), caller)
      entry.revision = this.revision(index)
      const key = type === 'machine' ? 'machines' : 'roles'
      entry[key] = [
        ...new Set([...entry[key].filter((item) => item !== value), ...(granted ? [value] : [])]),
      ]
      if (type === 'role') {
        entry.deniedRoles = (entry.deniedRoles || []).filter((role) => role !== value)
        if (!granted && entry.roles.includes('*')) entry.deniedRoles.push(value)
      }
      this.record(
        index,
        caller,
        granted ? 'grant' : 'revoke',
        entry.name,
        false,
        `${type} ${value === '*' ? 'all roles' : value}`,
      )
      return entry
    })
  }
  /** Owner decisions 2026-11-07 and 11-08: once the owner saved a site login's username and password, any
   * agent fixes the rest itself (machines, roles, sessions, login page, notes, site name), logged and shown
   * in the login's activity. Everything else in the store stays the owner's. Restricted roles (policy) keep
   * coordinator-given access only. */
  private siteLogin(entry: Login, caller: LoginCaller) {
    if (!caller.owner && !entry.lab)
      throw new LoginError(`${loginLabel(entry)} is not a site login. ${OWNER_CHANGES}`)
    return entry
  }
  private selfService(caller: LoginCaller) {
    if (!caller.owner && policy.restrictedRoles.includes(caller.role))
      throw new LoginError(
        `Role ${caller.role} does not change login access; a coordinator assigns lab targets (aico logins assign SESSION --target TARGET)`,
      )
  }
  /** Agents may open a login to their own session and to unrestricted roles; another session (it may be
   * a hunter's) is a coordinator's or the owner's call, as is anything for a restricted role. */
  private subjects(caller: LoginCaller, role?: string, session?: string) {
    if (caller.owner) return
    if (role && policy.restrictedRoles.includes(role))
      throw new LoginError(
        `Role ${role} gets lab targets from a coordinator: aico logins assign SESSION --target TARGET`,
      )
    if (session && session !== caller.session && caller.role !== 'coordinator')
      throw new LoginError(
        `Only a coordinator or the owner opens a login to another session (${session}); your own session needs no flag.`,
      )
  }
  private coordinator(caller: LoginCaller) {
    if (!caller.owner && caller.role !== 'coordinator')
      throw new LoginError('Only a coordinator or the owner can manage lab assignments')
  }
  /** A login by name or site name for a change that does not read it (no access check). */
  private existing(index: Index, name: string, caller: LoginCaller) {
    const found = this.find(index, loginName(name))
    // An agent only changes site logins: a key of the same name doesn't hide the site's.
    const entry =
      found && !found.lab && !caller.owner ? (this.siteNamed(index, name) ?? found) : found
    if (!entry || (!caller.owner && entry.verifierOnly))
      throw new LoginError(`No login named ${name}. aico logins list shows every saved login.`)
    return entry
  }
  private addTarget(index: Index, session: string, target: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session)) throw new LoginError('Invalid session')
    const targets = [...new Set([...(index.assignments[session] || []), target])]
    index.assignments[session] = targets
    index.assignmentVersions ||= {}
    index.assignmentVersions[session] = { targets, revision: this.revision(index) }
  }
  /** Gives SUBJECT (the caller, or --role / --session / --machine) whatever it lacks to use NAME, in
   * one change, and logs it on the login. Returns what changed; empty when it could already. */
  allow(
    name: string,
    subject: { role?: string; session?: string; machine?: string },
    caller: LoginCaller,
  ): { name: string; changed: string[] } {
    this.selfService(caller)
    this.subjects(caller, subject.role, subject.session)
    for (const value of [subject.role, subject.machine])
      if (value !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(value))
        throw new LoginError('Invalid role or machine')
    const who: LoginCaller = {
      role: subject.role ?? caller.role,
      machine: subject.machine ?? caller.machine,
      ...(subject.role
        ? {}
        : subject.session || caller.session
          ? { session: subject.session || caller.session }
          : {}),
    }
    return this.change((index) => {
      const entry = this.siteLogin(this.existing(index, name, caller), caller)
      const gaps = this.gaps(entry, who, index)
      if (gaps.some((gap) => gap.kind === 'policy'))
        throw new LoginError(unavailableText(entry, who, gaps))
      const changed: string[] = []
      for (const gap of gaps) {
        if (gap.kind === 'machine') {
          entry.machines = [...new Set([...entry.machines, gap.value])]
          changed.push(`machine ${gap.value}`)
        } else if (gap.kind === 'role') {
          entry.roles = [...new Set([...entry.roles, gap.value])]
          entry.deniedRoles = (entry.deniedRoles || []).filter((role) => role !== gap.value)
          changed.push(`role ${gap.value}`)
        } else if (gap.kind === 'session' && entry.lab) {
          this.addTarget(index, gap.value, entry.lab.target)
          changed.push(`session ${gap.value}`)
        }
      }
      // Another session may run under a role that All roles does not reach (a hunter): assign its target.
      if (
        subject.session &&
        entry.lab &&
        !index.assignments[subject.session]?.includes(entry.lab.target)
      ) {
        this.addTarget(index, subject.session, entry.lab.target)
        changed.push(`session ${subject.session}`)
      }
      if (changed.length) {
        entry.revision = this.revision(index)
        this.record(index, caller, 'allow', entry.name, false, changed.join(', '))
      }
      return { name: loginLabel(entry), changed }
    })
  }
  /** Changes what an agent may change itself: notes, the login page (same site; another site needs the
   * owner's password again), and an account or lab login's site name. Never a username or password. */
  edit(name: string, patch: LoginEdit, caller: LoginCaller): Login {
    this.selfService(caller)
    if (patch.notes !== undefined && (typeof patch.notes !== 'string' || patch.notes.length > 4000))
      throw new LoginError('Invalid login notes')
    return this.change((index) => {
      let entry = this.siteLogin(this.existing(index, name, caller), caller)
      const changed: string[] = []
      if (patch.notes !== undefined && patch.notes !== entry.notes) {
        entry.notes = patch.notes
        changed.push('notes')
      }
      if (patch.kind !== undefined && patch.kind !== entry.kind) {
        if (!LOGIN_KINDS.includes(patch.kind) || patch.kind === 'lab login' || entry.lab)
          throw new LoginError('Choose tool login, API key, password or backup key')
        entry.kind = patch.kind
        changed.push('kind')
      }
      for (const [path, add] of [
        [patch.program, true],
        [patch.dropProgram, false],
      ] as const) {
        if (path === undefined) continue
        if (typeof path !== 'string') throw new LoginError('Invalid program')
        if (!entry.lab) throw new LoginError('Only account and lab logins go to programs')
        const programs = entry.lab.programs || []
        const program = add
          ? labProgramPath(path, this.env)
          : programs.find(
              (p) =>
                p === declared(path, this.env) || sameFile(p, realFile(path, this.env), this.env),
            )
        if (!program) throw new LoginError(`${path} is not one of ${loginLabel(entry)}'s programs`)
        if (programs.includes(program) === add) continue
        const next = add ? [...programs, program] : programs.filter((p) => p !== program)
        entry.lab = { ...entry.lab, programs: next }
        if (!next.length) delete entry.lab.programs
        changed.push(`${add ? 'program' : 'no program'} ${program}`)
      }
      if (patch.login_url !== undefined || patch.target !== undefined) {
        const lab = entry.lab
        if (!lab)
          throw new LoginError('Only account and lab logins have a login page and site name')
        const file = join(this.folder, entry.file)
        const bundle = labPayload(privateFile(file).toString(), lab.target, lab.actor, true)
        if (patch.login_url !== undefined && patch.login_url !== bundle.values.login_url) {
          const next = loginPage(patch.login_url)
          const saved = (() => {
            try {
              return new URL(bundle.values.login_url || '')
            } catch {
              return undefined
            }
          })()
          // The saved password goes only to the site the owner saved; the owner may move it.
          if (
            !caller.owner &&
            (saved ? saved.origin !== new URL(next).origin : lab.kind === 'account')
          )
            throw new LoginError(
              `That login page is on another site (${new URL(next).host}): the saved password goes only to ${saved?.host || 'the site the owner saved'}. The owner moves it on Aico's Logins page (Edit).`,
            )
          bundle.values.login_url = next
          changed.push(`login page ${next}`)
        }
        let target = lab.target
        if (patch.target !== undefined && patch.target !== lab.target) {
          const renamed = labIdentity(patch.target, lab.actor)
          if (index.entries.some((e) => e.name === renamed.name))
            throw new LoginError(`A login for ${patch.target} already exists`)
          changed.push(`site name ${lab.target} to ${patch.target}`)
          target = patch.target
        }
        if (changed.some((c) => c.startsWith('login page') || c.startsWith('site name'))) {
          const identity = labIdentity(target, lab.actor)
          writePrivate(
            join(this.folder, identity.name),
            JSON.stringify({ ...bundle, reference: identity.reference }),
          )
          if (identity.name !== entry.name) {
            unlinkSync(file)
            index.tombstones ||= {}
            index.tombstones[entry.name] = this.revision(index)
            // A session keeps the old site name while another login (another actor) still uses it.
            const shared = index.entries.some(
              (e) => e.name !== entry.name && e.lab?.target === lab.target,
            )
            for (const [session, targets] of Object.entries(index.assignments))
              if (targets.includes(lab.target)) {
                index.assignments[session] = [
                  ...new Set(
                    targets.flatMap((t) =>
                      t !== lab.target ? [t] : shared ? [t, target] : [target],
                    ),
                  ),
                ]
                index.assignmentVersions ||= {}
                index.assignmentVersions[session] = {
                  targets: index.assignments[session],
                  revision: this.revision(index),
                }
              }
            const old = entry.name
            entry = { ...entry, name: identity.name, file: identity.name }
            index.entries = [...index.entries.filter((e) => e.name !== old), entry]
          }
          entry.lab = {
            ...lab,
            target,
            fields: Object.keys(bundle.values),
            ...(lab.kind === 'account' && bundle.values.login_url
              ? { login_url: bundle.values.login_url }
              : {}),
          }
        }
      }
      if (changed.length) {
        entry.revision = this.revision(index)
        this.record(index, caller, 'edit', entry.name, false, changed.join(', '))
      }
      return structuredClone(entry)
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
      index.entries = index.entries.filter((e) => e.name !== entry.name)
      index.tombstones ||= {}
      index.tombstones[entry.name] = this.revision(index)
      this.record(index, caller, 'remove', entry.name)
    })
  }
  assignments(caller: LoginCaller) {
    this.coordinator(caller)
    return this.read().assignments
  }
  assign(session: string, targets: string[], caller: LoginCaller) {
    this.coordinator(caller)
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session)) throw new LoginError('Invalid session')
    for (const target of targets) labIdentity(target, 'default')
    this.change((index) => {
      index.assignments[session] = [...new Set(targets)]
      index.assignmentVersions ||= {}
      index.assignmentVersions[session] = {
        targets: [...new Set(targets)],
        revision: this.revision(index),
      }
      this.record(
        index,
        caller,
        'assign',
        session,
        false,
        `targets ${[...new Set(targets)].join(', ') || 'none'}`,
      )
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
        const programs: unknown = entry.lab.programs
        if (
          programs !== undefined &&
          (!Array.isArray(programs) ||
            programs.some((p) => typeof p !== 'string' || !/^(\/|~\/)/.test(p)))
        )
          throw new LoginError('Invalid login snapshot')
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
          typeof event.actor !== 'string' ||
          (event.detail !== undefined &&
            (typeof event.detail !== 'string' || event.detail.length > 600)),
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

  /** The values PROGRAM (the code `lab run` starts, see labChildProgram) may have: only the shared
   * adapters (policy labPrograms) and the programs each login declares get them. */
  resolveLab(target: string, requests: unknown, caller: LoginCaller, program?: unknown) {
    labIdentity(target, 'default')
    if (typeof program !== 'string' || !program.startsWith('/'))
      throw new LoginError('Lab run needs the program it hands the values to')
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
          if (!labPrograms(entry).some((p) => sameFile(p, program, this.env)))
            throw new LoginError(
              policy.restrictedRoles.includes(caller.role) && !caller.owner
                ? `${loginLabel(entry)} does not go to ${program}; a coordinator adds it: aico logins edit ${loginLabel(entry)} --program ${program}`
                : `${loginLabel(entry)} does not go to ${program}. If that program should get it: aico logins edit ${loginLabel(entry)} --program ${program}`,
            )
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
          if (this.record(index, caller, 'lab use', name, true, `program ${program}`)) {
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

/** The programs a lab login's values may go to: the shared adapters, then the login's own. */
export function labPrograms(entry: Pick<Login, 'lab'>): string[] {
  return [...policy.labPrograms, ...(entry.lab?.programs || [])]
}

/** A declared program as an absolute path: `~/` is the store's home. */
function declared(value: string, env: NodeJS.ProcessEnv): string {
  if (typeof value !== 'string') throw new LoginError('Invalid program')
  const path = value.startsWith('~/') ? join(env.HOME || '', value.slice(2)) : value
  if (!isAbsolute(path)) throw new LoginError('A program is an absolute path')
  return resolve(path)
}

/** A declared program's real path now, or '' when it is gone. */
function realFile(path: string, env: NodeJS.ProcessEnv): string {
  try {
    return realpathSync(declared(path, env))
  } catch {
    return ''
  }
}

/** Whether declared program PATH is, by real path now, the file REAL. */
function sameFile(path: string, real: string, env: NodeJS.ProcessEnv): boolean {
  return !!real && realFile(path, env) === real
}

/** Interpreters and shells run whatever they are told, so one is never a program a login goes to. */
function interpreter(real: string): boolean {
  return new RegExp(policy.labInterpreters).test(basename(real))
}

/** A program a login may go to, as declared (an existing file, never an interpreter or shell). */
export function labProgramPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = declared(value, env)
  let real: string
  try {
    real = realpathSync(path)
    if (!statSync(real).isFile()) throw new Error('not a file')
  } catch {
    throw new LoginError(`No program at ${value}`)
  }
  if (interpreter(real))
    throw new LoginError(
      `${value} is an interpreter or shell and would run anything; name the script it runs (PYTHON -I SCRIPT)`,
    )
  return path
}

/** The code a `lab run` child runs, by real path: an `INTERPRETER -I SCRIPT` child (the adapters'
 * Python form) runs SCRIPT, anything else its own executable. Another interpreter form is refused. */
export function labChildProgram(command: string[]): string {
  const [executable, flag, script] = command
  if (!executable || !isAbsolute(executable))
    throw new LoginError('Lab run needs a request file and absolute child')
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      throw new LoginError(`No program at ${path}`)
    }
  }
  const program = real(executable)
  if (!interpreter(program)) return program
  const python = /^python/.test(basename(program))
  if (python && flag === '-I' && script && isAbsolute(script)) return real(script)
  throw new LoginError(
    python
      ? `${executable} would run anything; start the script as ${executable} -I /absolute/script.py`
      : `${executable} would run anything; run the program itself (or a Python script as PYTHON -I SCRIPT)`,
  )
}

/** A login page agents may set: https, or http on this machine (a local test page). */
export function loginPage(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new LoginError('The login page must be a full URL (https://...)')
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new LoginError('The login page must be an https URL')
  return url.href
}

export { policy as loginPolicy }
