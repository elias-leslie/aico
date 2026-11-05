// Pi's read, bash, edit and write tools, unchanged except for what the model is told:
// our own one-line descriptions, and parameter schemas without Pi's prose. The
// publication guard runs before every bash call when the role needs it. A contained
// role's bash runs in a sandbox (contain_command: no network but loopback, a read-only
// system with only the working folder writable, private /tmp and /run, sockets masked,
// session variables cleared), and its write and edit stay inside the working folder.

import { spawn } from 'node:child_process'
import { constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent'

/** How a contained role's tools run (data/harness.json contain_*). */
export interface Contain {
  /** The sandbox command bash runs under, before the per-call binds. */
  command: readonly string[]
  /** Folders hidden from bash (sockets live there); `~/` is the home folder. */
  hide: readonly string[]
  /** Variables bash does not get; a trailing `*` matches a prefix. */
  unsetEnv: readonly string[]
}

const FACTORIES: Readonly<Record<string, (cwd: string) => AgentTool>> = {
  read: createReadTool as (cwd: string) => AgentTool,
  bash: createBashTool as (cwd: string) => AgentTool,
  edit: createEditTool as (cwd: string) => AgentTool,
  write: createWriteTool as (cwd: string) => AgentTool,
}

/** A JSON schema without `description` fields (property names stay). */
function bare(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(bare)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description') continue
    out[key] =
      key === 'properties' && value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([name, prop]) => [name, bare(prop)]))
        : bare(value)
  }
  return out
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

const within = (path: string, dirs: readonly string[]) =>
  dirs.some((dir) => path === dir || path.startsWith(dir === sep ? dir : `${dir}${sep}`))

/** The real paths of the sockets listening on this host (/proc/net/unix), existing ones only. */
function listeningSockets(table = '/proc/net/unix'): string[] {
  let text: string
  try {
    text = readFileSync(table, 'utf8')
  } catch {
    return []
  }
  const out = new Set<string>()
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    const path = fields.slice(7).join(' ')
    if (fields[3] !== '00010000' || !path.startsWith('/')) continue
    try {
      if (lstatSync(path).isSocket()) out.add(realpathSync(path))
    } catch {}
  }
  return [...out]
}

/** The full sandbox command for one bash call in `cwd`, up to the program it runs. */
function sandboxArgs(contain: Contain, cwd: string, home = homedir()): string[] {
  const root = realpathSync(cwd)
  const args = [...contain.command]
  const masked = args.flatMap((arg, i) => (arg === '--tmpfs' ? [args[i + 1] as string] : []))
  for (const raw of contain.hide) {
    const dir = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    const real = realpathSync(dir)
    if (within(real, masked)) continue
    args.push('--tmpfs', real)
    masked.push(real)
  }
  args.push('--bind', root, root)
  const git = join(root, '.git')
  if (existsSync(git)) args.push('--ro-bind', git, git)
  // The working folder is the host's again under its bind, so its sockets are masked too.
  for (const socket of listeningSockets())
    if (!within(socket, masked) || within(socket, [root]))
      args.push('--ro-bind', '/dev/null', socket)
  args.push('--chdir', cwd)
  return args
}

/** `env` without the variables `unset` names (a trailing `*` matches a prefix). */
function clearedEnv(env: NodeJS.ProcessEnv, unset: readonly string[]): NodeJS.ProcessEnv {
  const gone = (key: string) =>
    unset.some((name) => (name.endsWith('*') ? key.startsWith(name.slice(0, -1)) : key === name))
  return Object.fromEntries(Object.entries(env).filter(([key]) => !gone(key)))
}

/** The real path `path` reaches: its own when it exists, else its nearest existing folder's plus the rest. */
function reach(path: string): string {
  let head = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync(head), ...rest)
    } catch {
      const up = dirname(head)
      if (up === head) return resolve(path)
      rest.unshift(basename(head))
      head = up
    }
  }
}

/** Why a contained role may not write `path`, or null: only inside the working folder, never in a .git folder. */
export function writeRefusal(cwd: string, path: string): string | null {
  const root = reach(cwd)
  const rel = relative(root, reach(path))
  if (rel.startsWith('..') || isAbsolute(rel))
    return `${path} is outside the working folder ${root}; this role writes only there`
  if (rel.split(sep).includes('.git'))
    return `${path} is inside a .git folder; this role does not write there`
  return null
}

function contained(cwd: string): (path: string) => void {
  return (path) => {
    const why = writeRefusal(cwd, path)
    if (why) throw new Error(why)
  }
}

/** A contained role's version of a tool, or the plain one. */
function toolFor(
  name: string,
  cwd: string,
  contain: Contain | null,
  sessionId?: string,
): AgentTool {
  const factory = FACTORIES[name]
  if (!factory) throw new Error(`no tool '${name}'`)
  if (!contain && name === 'bash' && sessionId)
    return createBashTool(cwd, {
      spawnHook: (context) => ({ ...context, env: { ...context.env, AICO_WIDGET_ID: sessionId } }),
    }) as AgentTool
  if (!contain) return factory(cwd)
  const check = contained(cwd)
  if (name === 'bash')
    return createBashTool(cwd, {
      spawnHook: (context) => ({
        ...context,
        command: `exec ${sandboxArgs(contain, context.cwd).map(quote).join(' ')} bash -c ${quote(context.command)}`,
        env: clearedEnv(context.env, contain.unsetEnv),
      }),
    }) as AgentTool
  if (name === 'write')
    return createWriteTool(cwd, {
      operations: {
        mkdir: async (dir) => {
          check(dir)
          await mkdir(dir, { recursive: true })
        },
        writeFile: async (path, content) => {
          check(path)
          await writeFile(path, content, 'utf-8')
        },
      },
    }) as AgentTool
  if (name === 'edit')
    return createEditTool(cwd, {
      operations: {
        access: async (path) => {
          check(path)
          await access(path, constants.R_OK | constants.W_OK)
        },
        readFile: (path) => readFile(path),
        writeFile: async (path, content) => {
          check(path)
          await writeFile(path, content, 'utf-8')
        },
      },
    }) as AgentTool
  return factory(cwd)
}

/** The level's tools for `cwd`, described by `descriptions`; contained when `contain` is given. */
export function leanTools(
  cwd: string,
  names: readonly string[],
  descriptions: Record<string, string>,
  contain: Contain | null = null,
  sessionId?: string,
): AgentTool[] {
  return names.map((name) => {
    const description = descriptions[name]
    if (!description) throw new Error(`no tool '${name}'`)
    const tool = toolFor(name, cwd, contain, sessionId)
    return { ...tool, description, parameters: bare(tool.parameters) as AgentTool['parameters'] }
  })
}

const GUARD_TIMEOUT_MS = 10_000

/** Why a parsed guard answer blocks the call, or null for an allow (`{}` or an explicit allow). */
function guardVerdict(answer: unknown): string | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer))
    return 'Publication guard gave no decision; execution refused.'
  const keys = Object.keys(answer)
  if (!keys.length) return null
  const decision = (answer as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput
  const verdict = decision?.permissionDecision
  if (verdict === 'allow' && keys.length === 1) return null
  const reason = decision?.permissionDecisionReason ?? (answer as { reason?: unknown }).reason
  if (verdict === 'deny') return String(reason || 'Blocked by the publication guard.')
  return `Publication guard answered ${JSON.stringify(verdict ?? (answer as { decision?: unknown }).decision ?? keys)}${reason ? ` (${String(reason)})` : ''}; execution refused.`
}

/**
 * The shared guard's answer for one bash command: `<hook> guard` (aico-hook) reads the
 * Claude-style PreToolUse payload. Only `{}` or an explicit allow lets the call run: a deny,
 * an ask, any other answer, a hook that fails, times out or prints something unreadable
 * refuses it. The hook runs in its own process group so a timeout kills its children too.
 */
export function guardBash(
  hook: string,
  command: string,
  cwd: string,
  callId: string,
  timeoutMs = GUARD_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const failed = (why: string) =>
      settle(`Publication guard unavailable (${why}); execution refused.`)
    const child = spawn(hook, ['guard'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true })
    const out: Buffer[] = []
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {}
      failed(`timeout after ${timeoutMs} ms`)
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', () => failed('hook did not start'))
    child.on('close', (code, signal) => {
      if (signal || code !== 0)
        return failed(signal ? `hook killed by ${signal}` : `hook exited ${code}`)
      let answer: unknown
      try {
        answer = JSON.parse(Buffer.concat(out).toString('utf8'))
      } catch {
        return failed('unreadable hook output')
      }
      settle(guardVerdict(answer))
    })
    child.stdin.end(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: callId,
        cwd,
      }),
    )
  })
}

/** Every spelling of each credential path a tool call could use: absolute, ~/, $HOME/ and home-relative. */
export function credentialMarkers(paths: readonly string[], home: string): string[] {
  const out = new Set<string>()
  for (const raw of paths) {
    const path = resolve(raw.startsWith('~/') ? join(home, raw.slice(2)) : raw)
    out.add(path)
    const rel = relative(home, path)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel))
      for (const form of [`~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`, rel]) out.add(form)
  }
  return [...out]
}

/** Whether a tool call's arguments name a credential path (its result is then kept out of agent.db). */
export function touchesCredentials(
  args: unknown,
  cwd: string,
  markers: readonly string[],
): boolean {
  const text = JSON.stringify(args ?? {})
  if (markers.some((marker) => text.includes(marker))) return true
  const path = (args as { path?: unknown } | null)?.path
  if (typeof path !== 'string') return false
  const full = resolve(cwd, path)
  return markers.some(
    (marker) => isAbsolute(marker) && (full === marker || full.startsWith(`${marker}/`)),
  )
}
