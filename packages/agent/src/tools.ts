// Pi's read, bash, edit and write tools, unchanged except for what the model is told:
// our own one-line descriptions, and parameter schemas without Pi's prose. The
// publication guard runs before every bash call when the role needs it.

import { spawn } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent'

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

/** The level's tools for `cwd`, described by `descriptions`. */
export function leanTools(
  cwd: string,
  names: readonly string[],
  descriptions: Record<string, string>,
): AgentTool[] {
  return names.map((name) => {
    const factory = FACTORIES[name]
    const description = descriptions[name]
    if (!factory || !description) throw new Error(`no tool '${name}'`)
    const tool = factory(cwd)
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
