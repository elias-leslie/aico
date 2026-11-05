import { spawn } from 'node:child_process'
import { fstatSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  type LoginCaller,
  LoginError,
  type LoginKind,
  type LoginStore,
  labIdentity,
  labPayload,
  loginMachine,
  loginPolicy,
} from './logins'
import { LoginClient } from './logins-client'
import { privateFile } from './secret-files'

export const LOGINS_USAGE = `Usage: aico logins <command> (also st logins)
Logins live in Aico's private secrets folder. Values enter through hidden input or stdin.
  list | show NAME                    metadata only
  set NAME [--kind KIND] [--notes TEXT] hidden prompt or piped stdin
  rotate NAME                         replace through hidden input or stdin
  get NAME                            only to an owner-only file; never a session log
  run --with NAME[=ENV] ... -- CMD      inject into one command's environment
  grant|revoke NAME --machine NAME | --role ROLE
  assign SESSION --target TARGET ...  coordinator or owner; replaces assigned targets
  unassign SESSION                    coordinator or owner; removes all target access
  assignments                        coordinator or owner; list assignments
  remove NAME                         owner only; type the name to confirm
  lab refs [--target TARGET]           assigned target references, no values
  lab enroll|refresh|patch --target TARGET --actor ACTOR [--kind synthetic|temporary|account]
      [--expires-at ISO] [--input FILE|-]   private fields JSON; stdin by default
  lab run --target TARGET --request FILE -- /absolute/child [ARGS]
      selected fields through AGENT_HUB_LAB_CREDENTIAL_FD; no child output
Coordinators assign lab targets with aico logins assign. The owner can also change them on the Logins page.`

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
}
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
export async function runLogins(
  args: string[],
  env = process.env,
  supplied?: Partial<LoginsIo>,
): Promise<number> {
  const io: LoginsIo = {
    out: (value) => process.stdout.write(value),
    err: (value) => process.stderr.write(value),
    caller: loginCaller(env),
    input: secretInput,
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
    ...supplied,
  }
  try {
    const [command, ...rest] = args
    if (!command || command === '--help' || command === '-h') {
      io.out(`${LOGINS_USAGE}\n`)
      return 0
    }
    const store = new LoginClient(env)
    // Caller checks and authority routing are shared with the owner page.
    const output = (value: unknown) => {
      io.out(`${JSON.stringify(value, null, 2)}\n`)
      if (store.warning) io.err(`${store.warning}\n`)
    }
    const flags = (input: string[], allowed: string[]) => {
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
    const one = (f: Record<string, string[]>, key: string) => {
      if ((f[key]?.length || 0) > 1) throw new LoginError('Duplicate login option')
      return f[key]?.[0]
    }
    if (command === 'list') {
      if (rest.length) throw new LoginError('list takes no values')
      output(await store.list(io.caller))
      return 0
    }
    if (command === 'show') {
      if (rest.length !== 1) throw new LoginError('show needs a name')
      output(await store.show(rest[0], io.caller))
      return 0
    }
    if (command === 'set' || command === 'rotate') {
      const [name, ...options] = rest
      const f = flags(options, ['--kind', '--notes'])
      output(
        await store.set(
          name,
          await io.input(),
          { kind: one(f, '--kind') as LoginKind | undefined, notes: one(f, '--notes') },
          io.caller,
          command === 'rotate',
        ),
      )
      return 0
    }
    if (command === 'get') {
      if (rest.length !== 1 || !io.outputSafe())
        throw new LoginError('get needs an owner-only file, never a session log')
      io.out((await store.value(rest[0], io.caller)).toString())
      return 0
    }
    if (command === 'run') {
      const split = rest.indexOf('--')
      if (split < 0 || !rest[split + 1]) throw new LoginError('run needs --with NAME -- COMMAND')
      const f = flags(rest.slice(0, split), ['--with'])
      if (!f['--with']?.length) throw new LoginError('run needs a login')
      return await io.execute(
        rest.slice(split + 1),
        await commandEnvironment(store, f['--with'], io.caller, env),
      )
    }
    if (command === 'grant' || command === 'revoke') {
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
    if (command === 'assignments') {
      output(await store.assignments(io.caller))
      return 0
    }
    if (command === 'assign' || command === 'unassign') {
      const [session, ...options] = rest,
        f = flags(options, ['--target'])
      if (!session || (command === 'assign' && !f['--target']?.length))
        throw new LoginError('assign needs a session and at least one target')
      await store.assign(session, command === 'unassign' ? [] : f['--target'], io.caller)
      output({ session, targets: command === 'unassign' ? [] : f['--target'] })
      return 0
    }
    if (command === 'remove') {
      if (rest.length !== 1 || !io.caller.owner)
        throw new LoginError('Only the owner can remove logins')
      io.err('Type the login name to remove it.\n')
      await store.remove(rest[0], io.caller, (await io.input()) === rest[0])
      output({ removed: rest[0] })
      return 0
    }
    if (command === 'lab') {
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
      if (action === 'run') {
        const command = split < 0 ? [] : options.slice(split + 1),
          request = one(f, '--request')
        if (!command[0] || !isAbsolute(command[0]) || !request)
          throw new LoginError('Lab run needs a request file and absolute child')
        let selection: unknown
        try {
          selection = JSON.parse(readFileSync(request, 'utf8'))
        } catch {
          throw new LoginError('Invalid lab request file')
        }
        const bundle = JSON.stringify(await store.resolveLab(target, selection, io.caller))
        if (Buffer.byteLength(bundle) > loginPolicy.maxValueBytes)
          throw new LoginError('Lab handoff is too large')
        return await io.execute(
          command,
          { PATH: '/usr/bin:/bin', AGENT_HUB_LAB_CREDENTIAL_FD: '3' },
          bundle,
        )
      }
      if (action === 'patch') {
        const input = one(f, '--input')
        const raw = input && input !== '-' ? privateFile(input).toString() : await io.input()
        let patch: unknown
        try {
          patch = JSON.parse(raw)
        } catch {
          throw new LoginError('Invalid lab patch JSON')
        }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch))
          throw new LoginError('Invalid lab patch JSON')
        await store.patchLab(
          target,
          actor,
          patch as Parameters<LoginStore['patchLab']>[2],
          io.caller,
        )
        output({ reference: labIdentity(target, actor).reference })
        return 0
      }
      if (action === 'enroll' || action === 'refresh') {
        const identity = labIdentity(target, actor),
          input = one(f, '--input')
        const raw = input && input !== '-' ? privateFile(input).toString() : await io.input()
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
    }
    throw new LoginError('Unknown login command; see aico logins --help')
  } catch (error) {
    io.err(
      `${error instanceof LoginError ? error.message : 'Logins could not complete the operation'}\n`,
    )
    return 1
  }
}
