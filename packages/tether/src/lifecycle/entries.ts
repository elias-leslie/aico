// Per-session entries (docs/api-v1.md Roots `entry`). A root created with
// `entry: {name, arg}` runs its agent through a program this host lists in
// `~/.config/tether/entries.json`, for example into a per-hunt container:
//
//   {"neri-hunt": {"argv": ["/home/me/.local/bin/neri-hunt-enter"],
//                  "home": "~/.local/state/neri-hunt/{arg}/home"}}
//
// Every launch of the session (first launch, restart, crash recovery, reboot
// restore) becomes `<argv> <arg> -- /bin/sh -c '<line>'`, so the agent never
// starts on the host. The agent is Claude Code, Codex or Pi (ENTRY_TOOLS).
// `home` is where the agent's own home is seen from the host: Tether reads
// Claude's session files and transcripts, Codex's rollouts, or the Pi session
// file of the conversation id it chose for the launch, there (continuity.ts
// `observeEntryAgent`), because the agent's pid is the container's and hooks
// cannot reach this Tether from inside.
//
// Tether passes nothing else to the entry: no socket, no path. What crosses
// into the container is the entry program's choice.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { ENTRY_HOME_ENV, ENTRY_TOOL_ENV, ENTRY_TOOLS, type EntryTool } from '../continuity'
import { getSessionEntry, getWidget, type SessionEntry } from './catalog'
import { shellQuote } from './tui/launch'

export type { SessionEntry }
/** Set on the entry process only: state readers find it in the pane by this
 * marker and read the agent's files under its home (continuity.ts). */
export { ENTRY_HOME_ENV, ENTRY_TOOL_ENV, ENTRY_TOOLS, type EntryTool }

/** Whether an entry can run this tool. */
export function isEntryTool(tool: unknown): tool is EntryTool {
  return (ENTRY_TOOLS as readonly unknown[]).includes(tool)
}

/** An entry name in entries.json and in `entry.name`. */
export const ENTRY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
/** `entry.arg`: one word, no path or shell characters. */
export const ENTRY_ARG = /^[a-z0-9][a-z0-9-]{0,79}$/
/** What the launch line exits with when the entry is gone from entries.json. */
export const ENTRY_MISSING_EXIT = 78
/** EX_TEMPFAIL: an entry's prerequisites can return without changing its configuration. */
export const ENTRY_RETRY_EXIT = 75

const MAX_ARGV = 16

export interface ResolvedEntry {
  argv: string[]
  /** Read-only live-agent probe. Called with the entry arg appended; emits JSON. */
  probe?: string[]
  /** Absolute host path of the agent's home for this arg. */
  home: string
}

export type EntryLookup =
  | { kind: 'ok'; entry: ResolvedEntry }
  | { kind: 'unknown_entry'; reason: string }
  | { kind: 'invalid_config'; reason: string }

/** `$TETHER_ENTRIES_FILE`, else `$XDG_CONFIG_HOME/tether/entries.json`. */
export function entriesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TETHER_ENTRIES_FILE) return env.TETHER_ENTRIES_FILE
  const configRoot = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), '.config')
  return join(configRoot, 'tether', 'entries.json')
}

/** Why a create body's `entry` is malformed, or null when it is absent or fine. */
export function entryProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value))
    return 'entry is {"name": NAME, "arg": ARG}'
  const entry = value as Record<string, unknown>
  if (Object.keys(entry).some((key) => key !== 'name' && key !== 'arg'))
    return 'entry takes only name and arg'
  if (typeof entry.name !== 'string' || !ENTRY_NAME.test(entry.name))
    return 'entry.name is an entries.json name (lowercase letters, digits, dashes)'
  if (typeof entry.arg !== 'string' || !ENTRY_ARG.test(entry.arg))
    return 'entry.arg must match ^[a-z0-9][a-z0-9-]{0,79}$'
  return null
}

/** The entry of a create body; null when absent, undefined when malformed. */
export function parseEntry(value: unknown): SessionEntry | null | undefined {
  if (value === undefined || value === null) return null
  if (entryProblem(value)) return undefined
  const { name, arg } = value as SessionEntry
  return { name, arg }
}

function expandHome(template: string, arg: string, env: NodeJS.ProcessEnv): string | null {
  const filled = template.split('{arg}').join(arg)
  const path = filled.startsWith('~/')
    ? join(env.HOME ?? homedir(), filled.slice(2))
    : isAbsolute(filled)
      ? filled
      : null
  return path === null ? null : normalize(path)
}

/** This host's program and agent home for `entry`, read fresh each time. */
export function resolveEntry(
  entry: SessionEntry,
  env: NodeJS.ProcessEnv = process.env,
): EntryLookup {
  const file = entriesFilePath(env)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind: 'unknown_entry', reason: `this host has no ${file}` }
    return { kind: 'invalid_config', reason: `${file} could not be read` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'invalid_config', reason: `${file} is not valid JSON` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { kind: 'invalid_config', reason: `${file} must be an object of entries` }
  const all = parsed as Record<string, unknown>
  if (!Object.hasOwn(all, entry.name))
    return {
      kind: 'unknown_entry',
      reason: `${entry.name} is not in ${file}`,
    }
  const raw = all[entry.name]
  const bad = (why: string): EntryLookup => ({
    kind: 'invalid_config',
    reason: `${file} entry ${entry.name}: ${why}`,
  })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return bad('must be {"argv": [...], "home": "..."}')
  const { argv, home, probe } = raw as Record<string, unknown>
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.length > MAX_ARGV ||
    argv.some((word) => typeof word !== 'string' || !word || word.includes('\0'))
  )
    return bad(`argv must be 1-${MAX_ARGV} non-empty strings`)
  if (!isAbsolute(argv[0] as string)) return bad('argv[0] must be an absolute path')
  if (
    probe !== undefined &&
    (!Array.isArray(probe) ||
      probe.length === 0 ||
      probe.length > MAX_ARGV ||
      probe.some((word) => typeof word !== 'string' || !word || word.includes('\0')) ||
      !isAbsolute(probe[0] as string))
  )
    return bad('probe must be 1-16 non-empty strings with an absolute program path')
  if (typeof home !== 'string' || !home.includes('{arg}'))
    return bad('home must be a path containing {arg}')
  const resolved = expandHome(home, entry.arg, env)
  if (!resolved) return bad('home must start with ~/ or /')
  return {
    kind: 'ok',
    entry: {
      argv: argv as string[],
      home: resolved,
      ...(probe === undefined ? {} : { probe: probe as string[] }),
    },
  }
}

/** `<argv> <arg> -- /bin/sh -c '<line>'`, marked with the agent's home and tool. */
export function entryLaunchLine(
  entry: ResolvedEntry,
  arg: string,
  line: string,
  tool: EntryTool,
): string {
  return [
    '/usr/bin/env',
    `${ENTRY_HOME_ENV}=${shellQuote(entry.home)}`,
    `${ENTRY_TOOL_ENV}=${tool}`,
    ...entry.argv.map(shellQuote),
    shellQuote(arg),
    '--',
    '/bin/sh',
    '-c',
    shellQuote(line),
  ].join(' ')
}

/** The line a session's pane runs: the agent line itself, or for a session
 * with an entry, that line through the entry. An entry that is no longer in
 * entries.json never falls back to the host: the line says why and exits. */
export function sessionLaunchLine(
  widgetId: string,
  line: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (line === null) return null
  const entry = getSessionEntry(widgetId)
  if (!entry) return line
  const tool = getWidget(widgetId)?.tool
  const resolved = resolveEntry(entry, env)
  if (resolved.kind === 'ok' && isEntryTool(tool))
    return entryLaunchLine(resolved.entry, entry.arg, line, tool)
  const reason =
    resolved.kind === 'ok'
      ? `entry ${entry.name} cannot run ${tool ?? 'this tool'}`
      : resolved.reason
  console.error(`[tether:entries] session ${widgetId}: ${reason}`)
  return `printf '%s\\n' ${shellQuote(`Tether: ${reason}; the agent was not started.`)} >&2; exit ${ENTRY_MISSING_EXIT}`
}

/** The host path of a session's agent home when it runs through an entry. */
export function sessionEntryHome(
  widgetId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const entry = getSessionEntry(widgetId)
  if (!entry) return null
  const resolved = resolveEntry(entry, env)
  return resolved.kind === 'ok' ? resolved.entry.home : null
}
