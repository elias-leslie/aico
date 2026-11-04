// Pi's read, bash, edit and write tools, unchanged except for what the model is told:
// our own one-line descriptions, and parameter schemas without Pi's prose. The
// publication guard runs before every bash call when the role needs it.

import { spawn } from 'node:child_process'
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

/**
 * The shared publication guard's answer for one bash command (the Claude-style PreToolUse
 * payload). Anything but a clean allow blocks: a hook that fails, times out or prints
 * something unreadable refuses the call.
 */
export function guardBash(
  hook: string,
  command: string,
  cwd: string,
  callId: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const failed = (why: string) =>
      resolve(`Publication guard unavailable (${why}); execution refused.`)
    const child = spawn('bash', [hook], { stdio: ['pipe', 'pipe', 'ignore'] })
    const out: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), GUARD_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      failed('hook did not start')
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (signal || code !== 0)
        return failed(signal ? `hook killed by ${signal}` : `hook exited ${code}`)
      try {
        const decision = JSON.parse(Buffer.concat(out).toString('utf8')).hookSpecificOutput
        if (decision?.permissionDecision === 'deny')
          return resolve(
            String(decision.permissionDecisionReason || 'Blocked by the publication guard.'),
          )
        return resolve(null)
      } catch {
        return failed('unreadable hook output')
      }
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
