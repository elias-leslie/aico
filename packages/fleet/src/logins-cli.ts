import { spawn, spawnSync } from 'node:child_process'
import { fstatSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { probeLoginPage } from './login-probe'
import {
  LOGIN_KINDS,
  type LoginCaller,
  LoginError,
  type LoginKind,
  type LoginStore,
  labChildProgram,
  labIdentity,
  labPayload,
  loginMachine,
  loginPage,
  loginPolicy,
} from './logins'
import { LoginClient } from './logins-client'
import { privateFile } from './secret-files'

type LoginLine = {
  name: string
  kind?: string
  available?: boolean
  fix?: string
  state?: string
  usable?: boolean
}

/** The list an agent scans for a name; the rest is one `aico logins list NAME` away. */
function loginLines(logins: LoginLine[]): string {
  const lines = logins.map(
    ({ name, kind, available, fix, state, usable }) =>
      `${name}  ${kind ?? 'login'}  ${available === false ? (fix ?? 'not usable') : usable === false ? state : 'usable'}`,
  )
  return `${lines.join('\n')}\n`
}

/** `lab enroll` makes lab logins; set refuses them. The first kind is set's default. */
const SETTABLE_KINDS = LOGIN_KINDS.filter((kind) => kind !== 'lab login').join(', ')

export const LOGINS_USAGE = `Usage: aico logins <command> (also st logins)
Logins live in Aico's private secrets folder. Values enter through hidden input or stdin.
  list [TEXT] [--json]                every login, one line each: name, kind, then "usable" or the
                                      command that makes it usable. With TEXT (part of a name) or
                                      --json: the matching ones in full as JSON, no values, with
                                      state (Unused: no session has yet), usable and what is missing
  show NAME                           metadata and recent activity, no value (NAME or an account
                                      login's site name)
  allow NAME [--role ROLE | --session ID] [--machine NAME]
                                      site logins: give yourself (or ROLE; a coordinator: session ID) what
                                      is missing to use NAME: machine, role or session. Logged; no owner step
  edit NAME [--notes TEXT] [--kind KIND] [--login-url URL] [--site NAME] [--program PATH] [--no-program PATH]
                                      fix notes, the kind (owner, not a site login), the login page, the site name
                                      or the programs lab run may hand it to; the login page is
                                      checked for a password field. Logged; prints what show prints
  set NAME [--kind KIND] [--notes TEXT] owner, hidden prompt; a tool's own grant, piped stdin. KIND: ${SETTABLE_KINDS}
  set NAME --account --username USER --login-url URL [--notes TEXT]
                                      account login (username, password, login page); the
                                      password comes from hidden input; saved as lab target NAME
  rotate NAME                         replace through hidden input or stdin (not a key or tool login)
  get NAME                            only to an owner-only file; never a session log
  run --with NAME[=ENV] ... -- CMD      inject into one command's environment
  grant|revoke NAME --machine NAME | --role ROLE     logged on the login
  assign SESSION --target TARGET ...  coordinator or hunter coordinator: replaces a session's test
                                      logins; logged; no owner step
  unassign SESSION                    removes all target access
  hunters-ok NAME on|off              owner only: opens or closes a real account to hunters; logged
  assignments                        list assignments
  remove NAME                         owner only; type the name to confirm
  lab refs [--target TARGET]           assigned target references, no values
  lab enroll|refresh|patch --target TARGET --actor ACTOR [--kind synthetic|temporary|account]
      [--expires-at ISO] [--input FILE|-]   private fields JSON; stdin by default
  lab run --target TARGET --request FILE -- /absolute/child [ARGS]
      selected fields through AGENT_HUB_LAB_CREDENTIAL_FD; no child output. Only to the
      shared adapters and the login's own programs (edit --program); PYTHON -I SCRIPT
      counts as SCRIPT
Who does what:
  Owner: saves usernames and passwords, removes logins, owns API, backup and tool keys.
  Agents: fix everything else on a saved site login themselves, logged in its activity.
  Coordinators and hunter coordinators: also give hunters test logins (assign), no owner step.
  Hunters (restricted roles): use test logins for their sites; a missing one is asked of their
  coordinator, never the owner. The owner's real accounts stay closed to them unless the owner
  marked that login hunters OK on the Logins page.
Ask the owner (one tether ask create) only for a wrong or missing username or password, or a key
that doesn't exist yet.`

/** One command's lines of the usage above, so `aico logins edit --help` answers about edit. */
function commandUsage(command: string): string {
  const named = (line: string) => {
    const word = line.match(/^ {2}(\S+)/)?.[1]
    return word?.split('|').includes(command)
  }
  const lines = LOGINS_USAGE.split('\n')
  const picked = lines.filter((line, index) => {
    if (named(line)) return true
    // A continuation line belongs to the command above it.
    if (!/^ {3,}/.test(line)) return false
    for (let i = index - 1; i >= 0; i--) if (!/^ {3,}/.test(lines[i])) return named(lines[i])
    return false
  })
  return picked.length ? `${picked.join('\n')}\n` : `${LOGINS_USAGE}\n`
}

/** Recover only caller metadata when a harness filters its child environment. Never log /proc data. */
export function loginCaller(env: NodeJS.ProcessEnv = process.env): LoginCaller {
  let session = env.AICO_WIDGET_ID || env.AICO_SESSION_ID,
    role = env.ST_WORK_ROLE
  let pid = process.ppid
  for (let depth = 0; depth < 32 && pid > 1 && (!session || !role); depth++) {
    try {
      const pairs = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      session ||= pairs.find((p) => p.startsWith('AICO_WIDGET_ID='))?.slice(15)
      role ||= pairs.find((p) => p.startsWith('ST_WORK_ROLE='))?.slice(13)
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      pid = Number(
        stat
          .slice(stat.lastIndexOf(')') + 1)
          .trim()
          .split(/\s+/)[1],
      )
    } catch {
      break
    }
  }
  session = session?.replace(/^aico-widget-/, '')
  return {
    machine: loginMachine(),
    role: role || 'agent',
    ...(session ? { session } : {}),
    owner: !session && !role && !!process.stdin.isTTY,
  }
}
async function secretInput(): Promise<string> {
  if (!process.stdin.isTTY) {
    const parts: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk)
      if (bytes > loginPolicy.maxValueBytes) throw new LoginError('Login value is too large')
      parts.push(Buffer.from(chunk))
    }
    return Buffer.concat(parts)
      .toString()
      .replace(/\r?\n$/, '')
  }
  process.stderr.write('Value (hidden): ')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = ''
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString()) {
          if (char === '\u0003') {
            cleanup()
            reject(new LoginError('Cancelled'))
            return
          }
          if (char === '\r' || char === '\n') {
            cleanup()
            resolve(value)
            return
          }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
          else value += char
          if (Buffer.byteLength(value) > loginPolicy.maxValueBytes) {
            cleanup()
            reject(new LoginError('Login value is too large'))
            return
          }
        }
      }
      const cleanup = () => process.stdin.off('data', onData)
      process.stdin.on('data', onData)
    })
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stderr.write('\n')
  }
}
export interface LoginsIo {
  out(text: string): void
  err(text: string): void
  caller: LoginCaller
  input(): Promise<string>
  outputSafe(): boolean
  execute(command: string[], env: NodeJS.ProcessEnv, bundle?: string): Promise<number>
  /** Checks a login page for a password field (login-probe.ts). */
  probe(url: string): Promise<{ warning: string }>
  /** Whether Tether lists this session as a coordinator. */
  coordinates(session: string, env: NodeJS.ProcessEnv): boolean
}
/** A hunter coordinator is often the session that started the hunt, listed as a coordinator by Tether
 * with some other work role. Unreadable means no: the refusal says who can do it. */
function tetherCoordinates(session: string, env: NodeJS.ProcessEnv) {
  const answer = spawnSync('tether', ['--json', 'sessions', 'get', session], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  try {
    return JSON.parse(answer.stdout).coordinator === true
  } catch {
    return false
  }
}
/** Commands that do something only a coordinator may do. */
const coordinatorWork = (command: string, rest: string[]) =>
  ['assign', 'unassign', 'assignments'].includes(command) ||
  (['allow', 'grant', 'revoke'].includes(command) &&
    (rest.includes('--session') || rest.includes('--role')))
export async function commandEnvironment(
  store: { value(name: string, caller: LoginCaller): Buffer | Promise<Buffer> },
  bindings: string[],
  caller: LoginCaller,
  env: NodeJS.ProcessEnv,
) {
  const next = { ...env }
  for (const binding of bindings) {
    const [name, explicit, ...extra] = binding.split('=')
    const variable = explicit || name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
    if (extra.length || !/^[A-Z_][A-Z0-9_]*$/.test(variable))
      throw new LoginError('Invalid environment name')
    next[variable] = (await store.value(name, caller)).toString()
  }
  return next
}
/** An account login is the lab "account" shape: username, password and login page under target NAME. */
export async function saveAccount(
  store: Pick<LoginClient, 'set'>,
  target: string,
  fields: { username: string; login_url: string },
  password: string,
  caller: LoginCaller,
  notes?: string,
) {
  const identity = labIdentity(target, 'default')
  const bundle = labPayload(
    JSON.stringify({
      schema_version: 1,
      reference: identity.reference,
      kind: 'account',
      expires_at: null,
      values: { ...fields, password },
    }),
    target,
    'default',
  )
  return store.set(
    identity.name,
    JSON.stringify(bundle),
    {
      kind: 'lab login',
      ...(notes ? { notes } : {}),
      lab: {
        target,
        actor: 'default',
        kind: 'account',
        expires_at: null,
        fields: Object.keys(bundle.values),
      },
    },
    caller,
  )
}
function defaultIo(env: NodeJS.ProcessEnv): LoginsIo {
  return {
    out: (value) => process.stdout.write(value),
    err: (value) => process.stderr.write(value),
    caller: loginCaller(env),
    input: secretInput,
    probe: probeLoginPage,
    coordinates: tetherCoordinates,
    outputSafe: () => {
      if (process.stdout.isTTY) return false
      const stat = fstatSync(1)
      return stat.isFile() && stat.uid === process.getuid?.() && !(stat.mode & 0o077)
    },
    execute: (command, childEnv, bundle) =>
      new Promise((resolve) => {
        const child = spawn(command[0], command.slice(1), {
          env: childEnv,
          stdio: bundle ? ['ignore', 'ignore', 'ignore', 'pipe'] : 'inherit',
        })
        if (bundle) {
          const pipe = child.stdio[3]
          if (pipe && 'end' in pipe) {
            pipe.on('error', () => {})
            pipe.end(bundle)
          }
        }
        child.once('error', () => resolve(1))
        child.once('close', (code) => resolve(code ?? 1))
      }),
  }
}

function flags(input: string[], allowed: string[]) {
  const result: Record<string, string[]> = {}
  for (let i = 0; i < input.length; i += 2) {
    const flag = input[i],
      val = input[i + 1]
    if (!allowed.includes(flag) || val === undefined || val.startsWith('--'))
      throw new LoginError('Invalid login arguments; see aico logins --help')
    result[flag] ||= []
    result[flag].push(val)
  }
  return result
}

function one(f: Record<string, string[]>, key: string) {
  if ((f[key]?.length || 0) > 1) throw new LoginError('Duplicate login option')
  return f[key]?.[0]
}

/** One run of a login command: its name and arguments, and what every command writes through. */
type LoginRun = {
  command: string
  rest: string[]
  env: NodeJS.ProcessEnv
  io: LoginsIo
  // Caller checks and authority routing are shared with the owner page.
  store: LoginClient
  output: (value: unknown) => void
  probe: (url: string) => Promise<void>
}

async function listLogins({ rest, io, store, output }: LoginRun): Promise<number> {
  const words = rest.filter((word) => word !== '--json')
  if (words.length > 1 || words[0]?.startsWith('-'))
    throw new LoginError('list takes at most one text to look for, and --json')
  const logins = (await (io.caller.owner
    ? store.list(io.caller)
    : store.catalog(io.caller))) as LoginLine[]
  const text = words[0]?.toLowerCase()
  const found = text ? logins.filter((l) => l.name.toLowerCase().includes(text)) : logins
  // Stdout stays JSON for scripts; the plain words go beside it.
  if (text && !found.length)
    io.err(
      `No login has "${words[0]}" in its name. aico logins list shows every login you can use or be given.\n`,
    )
  if (text || rest.includes('--json')) output(found)
  else {
    io.out(loginLines(found))
    if (store.warning) io.err(`${store.warning}\n`)
  }
  return 0
}

async function allowLogin({ rest, io, store, output }: LoginRun): Promise<number> {
  const [name, ...options] = rest,
    f = flags(options, ['--role', '--session', '--machine'])
  const role = one(f, '--role'),
    session = one(f, '--session')
  if (!name) throw new LoginError('allow needs a login name; aico logins list shows them')
  if (role && session) throw new LoginError('Choose --role or --session, not both')
  const result = await store.allow(
    name,
    {
      ...(role ? { role } : {}),
      ...(session ? { session } : {}),
      ...(one(f, '--machine') ? { machine: one(f, '--machine') } : {}),
    },
    io.caller,
  )
  output(result)
  io.err(
    result.changed.length
      ? `Allowed ${result.changed.join(', ')} for ${result.name}; logged in its activity. Say so in your report.\n`
      : `${result.name} is already usable; nothing changed.\n`,
  )
  return 0
}

async function editLogin({ rest, io, store, output, probe }: LoginRun): Promise<number> {
  const [name, ...options] = rest,
    f = flags(options, ['--notes', '--kind', '--login-url', '--site', '--program', '--no-program'])
  const notes = one(f, '--notes'),
    kind = one(f, '--kind'),
    loginUrl = one(f, '--login-url'),
    site = one(f, '--site'),
    program = one(f, '--program'),
    dropProgram = one(f, '--no-program')
  if (!name || (notes === undefined && !kind && !loginUrl && !site && !program && !dropProgram))
    throw new LoginError(
      'edit needs a login and --notes, --kind, --login-url, --site, --program or --no-program',
    )
  const edited = await store.edit(
    name,
    {
      ...(notes !== undefined ? { notes } : {}),
      ...(kind ? { kind: kind as LoginKind } : {}),
      ...(loginUrl ? { login_url: loginUrl } : {}),
      ...(site ? { target: site } : {}),
      ...(program ? { program } : {}),
      ...(dropProgram ? { dropProgram } : {}),
    },
    io.caller,
  )
  // A login not yet open to this caller still took the fix; its state isn't theirs to read.
  let shown: unknown = edited
  try {
    shown = await store.details(edited.name, io.caller)
  } catch (error) {
    if (!(error instanceof LoginError)) throw error
  }
  output(shown)
  if (loginUrl) await probe(loginUrl)
  return 0
}

async function showLogin({ rest, io, store, output }: LoginRun): Promise<number> {
  if (rest.length !== 1) throw new LoginError('show needs a name')
  output(await store.details(rest[0], io.caller))
  return 0
}

async function saveLogin({ command, rest, io, store, output, probe }: LoginRun): Promise<number> {
  const [name, ...options] = rest
  const account = options.includes('--account')
  const f = flags(
    options.filter((o) => o !== '--account'),
    account ? ['--notes', '--username', '--login-url'] : ['--kind', '--notes'],
  )
  const secret = await io.input()
  if (account) {
    const username = one(f, '--username'),
      loginUrl = one(f, '--login-url')
    if (command !== 'set' || !username || !loginUrl)
      throw new LoginError(
        'An account login needs set NAME --account --username USER --login-url URL',
      )
    loginPage(loginUrl)
    output(
      await saveAccount(
        store,
        name,
        { username, login_url: loginUrl },
        secret,
        io.caller,
        one(f, '--notes'),
      ),
    )
    await probe(loginUrl)
  } else
    output(
      await store.set(
        name,
        secret,
        { kind: one(f, '--kind') as LoginKind | undefined, notes: one(f, '--notes') },
        io.caller,
        command === 'rotate',
      ),
    )
  // Length only, so a paste can be checked without echoing the value.
  const length = [...secret].length
  io.err(`Saved, ${length} ${length === 1 ? 'character' : 'characters'}\n`)
  return 0
}

async function getLogin({ rest, io, store }: LoginRun): Promise<number> {
  if (rest.length !== 1 || !io.outputSafe())
    throw new LoginError('get needs an owner-only file, never a session log')
  io.out((await store.value(rest[0], io.caller)).toString())
  return 0
}

async function runWithLogin({ rest, env, io, store }: LoginRun): Promise<number> {
  const split = rest.indexOf('--')
  if (split < 0 || !rest[split + 1]) throw new LoginError('run needs --with NAME -- COMMAND')
  const f = flags(rest.slice(0, split), ['--with'])
  if (!f['--with']?.length) throw new LoginError('run needs a login')
  return await io.execute(
    rest.slice(split + 1),
    await commandEnvironment(store, f['--with'], io.caller, env),
  )
}

async function grantLogin({ command, rest, io, store, output }: LoginRun): Promise<number> {
  const [name, ...options] = rest,
    f = flags(options, ['--machine', '--role'])
  const machine = one(f, '--machine'),
    role = one(f, '--role')
  if (!!machine === !!role) throw new LoginError('Choose one machine or role')
  output(
    await store.grant(
      name,
      machine ? 'machine' : 'role',
      machine || role || '',
      command === 'grant',
      io.caller,
    ),
  )
  return 0
}

async function markHuntersOk({ rest, io, store, output }: LoginRun): Promise<number> {
  const [name, state, ...extra] = rest
  if (!name || (state !== 'on' && state !== 'off') || extra.length)
    throw new LoginError('hunters-ok needs a login name, then on or off')
  output(await store.huntersOk(name, state === 'on', io.caller))
  return 0
}

async function listAssignments({ io, store, output }: LoginRun): Promise<number> {
  output(await store.assignments(io.caller))
  return 0
}

async function assignTargets({ command, rest, io, store, output }: LoginRun): Promise<number> {
  const [session, ...options] = rest,
    f = flags(options, ['--target'])
  if (!session || (command === 'assign' && !f['--target']?.length))
    throw new LoginError('assign needs a session and at least one target')
  await store.assign(session, command === 'unassign' ? [] : f['--target'], io.caller)
  output({ session, targets: command === 'unassign' ? [] : f['--target'] })
  return 0
}

async function removeLogin({ rest, io, store, output }: LoginRun): Promise<number> {
  if (rest.length !== 1 || !io.caller.owner)
    throw new LoginError('Only the owner can remove logins')
  io.err('Type the login name to remove it.\n')
  await store.remove(rest[0], io.caller, (await io.input()) === rest[0])
  output({ removed: rest[0] })
  return 0
}

/** A lab action's JSON input, from its --input file or stdin. */
async function labInput(f: Record<string, string[]>, io: LoginsIo) {
  const input = one(f, '--input')
  return input && input !== '-' ? privateFile(input).toString() : await io.input()
}

async function labRun(
  { io, store }: LoginRun,
  target: string,
  command: string[],
  f: Record<string, string[]>,
): Promise<number> {
  const request = one(f, '--request')
  if (!command[0] || !isAbsolute(command[0]) || !request)
    throw new LoginError('Lab run needs a request file and absolute child')
  const program = labChildProgram(command)
  let selection: unknown
  try {
    selection = JSON.parse(readFileSync(request, 'utf8'))
  } catch {
    throw new LoginError('Invalid lab request file')
  }
  const bundle = JSON.stringify(await store.resolveLab(target, selection, io.caller, program))
  if (Buffer.byteLength(bundle) > loginPolicy.maxValueBytes)
    throw new LoginError('Lab handoff is too large')
  return await io.execute(
    command,
    { PATH: '/usr/bin:/bin', AGENT_HUB_LAB_CREDENTIAL_FD: '3' },
    bundle,
  )
}

async function labPatch(
  { io, store, output }: LoginRun,
  target: string,
  actor: string,
  f: Record<string, string[]>,
): Promise<number> {
  const raw = await labInput(f, io)
  let patch: unknown
  try {
    patch = JSON.parse(raw)
  } catch {
    throw new LoginError('Invalid lab patch JSON')
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new LoginError('Invalid lab patch JSON')
  await store.patchLab(target, actor, patch as Parameters<LoginStore['patchLab']>[2], io.caller)
  output({ reference: labIdentity(target, actor).reference })
  return 0
}

async function labSave(
  { io, store, output }: LoginRun,
  action: 'enroll' | 'refresh',
  target: string,
  actor: string,
  f: Record<string, string[]>,
): Promise<number> {
  const identity = labIdentity(target, actor)
  const raw = await labInput(f, io)
  let values: unknown
  try {
    values = JSON.parse(raw)
  } catch {
    throw new LoginError('Invalid lab fields JSON')
  }
  const old = action === 'refresh' ? await store.show(identity.name, io.caller) : undefined
  const bundle = labPayload(
    JSON.stringify({
      schema_version: 1,
      reference: identity.reference,
      kind: old?.lab?.kind || one(f, '--kind') || 'synthetic',
      expires_at: one(f, '--expires-at') || null,
      values,
    }),
    target,
    actor,
  )
  if (old?.lab?.kind === 'temporary')
    throw new LoginError('Temporary lab logins cannot be refreshed')
  await store.set(
    identity.name,
    JSON.stringify(bundle),
    {
      kind: 'lab login',
      lab: {
        target,
        actor,
        kind: bundle.kind,
        expires_at: bundle.expires_at,
        fields: Object.keys(bundle.values),
      },
    },
    io.caller,
    action === 'refresh',
  )
  output({ reference: identity.reference })
  return 0
}

async function runLab(run: LoginRun): Promise<number> {
  const { rest, io, store, output } = run
  const [action, ...options] = rest,
    split = options.indexOf('--')
  const f = flags(split < 0 ? options : options.slice(0, split), [
    '--target',
    '--actor',
    '--kind',
    '--expires-at',
    '--input',
    '--request',
  ])
  const target = one(f, '--target'),
    actor = one(f, '--actor') || 'default'
  if (action === 'refs') {
    output({
      references: (await store.list(io.caller))
        .filter((e) => e.lab && (!target || e.lab.target === target))
        .flatMap((e) => (e.lab ? [labIdentity(e.lab.target, e.lab.actor).reference] : [])),
    })
    return 0
  }
  if (!target) throw new LoginError('A lab target is required')
  if (action === 'run') return labRun(run, target, split < 0 ? [] : options.slice(split + 1), f)
  if (action === 'patch') return labPatch(run, target, actor, f)
  if (action === 'enroll' || action === 'refresh') return labSave(run, action, target, actor, f)
  throw new LoginError(UNKNOWN_COMMAND)
}

const UNKNOWN_COMMAND = 'Unknown login command; see aico logins --help'

const COMMANDS = new Map<string, (run: LoginRun) => Promise<number>>([
  ['list', listLogins],
  ['allow', allowLogin],
  ['edit', editLogin],
  ['show', showLogin],
  ['set', saveLogin],
  ['rotate', saveLogin],
  ['get', getLogin],
  ['run', runWithLogin],
  ['grant', grantLogin],
  ['revoke', grantLogin],
  ['assignments', listAssignments],
  ['assign', assignTargets],
  ['unassign', assignTargets],
  ['hunters-ok', markHuntersOk],
  ['remove', removeLogin],
  ['lab', runLab],
])

export async function runLogins(
  args: string[],
  env = process.env,
  supplied?: Partial<LoginsIo>,
): Promise<number> {
  const io: LoginsIo = { ...defaultIo(env), ...supplied }
  try {
    const [command, ...rest] = args
    if (!command || command === '--help' || command === '-h') {
      io.out(`${LOGINS_USAGE}\n`)
      return 0
    }
    // Only ours: what follows `run ... --` belongs to the command being run.
    const own = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
    if (own.includes('--help') || own.includes('-h')) {
      io.out(commandUsage(command))
      return 0
    }
    // Work role coordinator already qualifies; a restricted role never does.
    if (
      io.caller.session &&
      !io.caller.owner &&
      ![...loginPolicy.coordinatorRoles, ...loginPolicy.restrictedRoles].includes(io.caller.role) &&
      coordinatorWork(command, rest)
    )
      io.caller = { ...io.caller, coordinator: io.coordinates(io.caller.session, env) }
    const store = new LoginClient(env)
    const handler = COMMANDS.get(command)
    if (!handler) throw new LoginError(UNKNOWN_COMMAND)
    return await handler({
      command,
      rest,
      env,
      io,
      store,
      output: (value) => {
        io.out(`${JSON.stringify(value, null, 2)}\n`)
        if (store.warning) io.err(`${store.warning}\n`)
      },
      probe: async (url) => {
        const checked = await io.probe(url)
        if (checked.warning) io.err(`${checked.warning}\n`)
      },
    })
  } catch (error) {
    io.err(
      `${error instanceof LoginError ? error.message : 'Logins could not complete the operation'}\n`,
    )
    return 1
  }
}
