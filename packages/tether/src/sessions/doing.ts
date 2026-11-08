// Short lines about a conversation, built from one transcript record: what the agent is
// doing right now ("Editing history.ts", "Running: npm test", its last sentence) and the
// trimmed first prompt a conversation is named by. No model call: a tool call is worded
// from its name and arguments, the rest is the agent's own text cut to a sentence. Every
// line is masked (known token shapes) before it is cut, so a cut never leaves half a token.

import { maskKnownSecrets } from '@aico/shared/secrets'

/** The longest "doing now" line. */
const DOING_MAX = 120
/** The longest name taken from a first prompt. */
const NAME_MAX = 70

function flat(text: string): string {
  return maskKnownSecrets(text).replace(/\s+/g, ' ').trim()
}

function cut(text: string, max: number): string {
  const line = flat(text)
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

/** Markdown marks and links reduced to their words (underscores stay: they are in names). */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*]+/g, '')
    .replace(/^[#>\s]+/gm, '')
}

/** The last sentence of what the agent said: "Now I'll update the reader." */
export function lastSentence(text: string): string | undefined {
  // Only the end matters, but the mask sees the whole message: a token the slice would split stays hidden.
  const safe = maskKnownSecrets(text)
  const sentences = flat(plain(safe.length > 1500 ? safe.slice(-1500) : safe))
    .split(/(?<=[.!?:])\s+/)
    .map((part) => part.trim())
    .filter((part) => /[\p{L}\p{N}]/u.test(part))
  const last = sentences.at(-1)
  return last ? cut(last, DOING_MAX) : undefined
}

/** A conversation's name from its first prompt: one line, cut at a word. */
export function promptName(text: string): string | undefined {
  const safe = maskKnownSecrets(text)
  const line = flat(plain(safe.slice(0, 600)))
  if (!/[\p{L}\p{N}]/u.test(line)) return undefined
  if (line.length <= NAME_MAX) return line
  const head = line.slice(0, NAME_MAX)
  const space = head.lastIndexOf(' ')
  return `${(space > NAME_MAX / 2 ? head.slice(0, space) : head).trimEnd()}…`
}

/** Setup text a tool puts in the owner's seat itself: not something they said. */
export const INJECTED_PROMPT =
  /^\s*(<[a-z][\w-]*[\s>]|# AGENTS\.md instructions|\[Message\]|Caveat: The messages below)/i

const first = (
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) return value
    if (Array.isArray(value) && value.every((item) => typeof item === 'string') && value.length)
      return value.join(' ')
  }
  return undefined
}

/** A tool call in the present tense. `undefined`: it says nothing about what is going on
 * (bookkeeping such as a todo list), so the line stays as it was. */
export function toolDoing(
  tool: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  const name = (tool.split('__').at(-1) ?? tool).toLowerCase()
  const target = first(args, 'file_path', 'path', 'notebook_path', 'filePath')
  const file = target ? baseName(target) : undefined
  switch (name) {
    case 'bash':
    case 'exec_command':
    case 'shell':
    case 'shell_command':
    case 'local_shell':
    case 'run_command':
    case 'exec': {
      const command = first(args, 'command', 'cmd', 'CommandLine')
      return command ? `Running: ${cut(command, 90)}` : 'Running a command'
    }
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
    case 'str_replace':
    case 'str_replace_editor':
    case 'edit_file':
      return file ? `Editing ${file}` : 'Editing a file'
    case 'write':
    case 'write_file':
      return file ? `Writing ${file}` : 'Writing a file'
    case 'read':
    case 'view':
    case 'view_file':
    case 'read_file':
      return file ? `Reading ${file}` : 'Reading a file'
    case 'grep':
    case 'glob':
    case 'find':
    case 'search':
    case 'ls': {
      const what = first(args, 'pattern', 'query', 'glob')
      return what ? `Searching for ${cut(what, 60)}` : 'Searching the project'
    }
    case 'websearch':
    case 'web_search': {
      const query = first(args, 'query')
      return query ? `Searching the web: ${cut(query, 70)}` : 'Searching the web'
    }
    case 'webfetch':
    case 'web_fetch': {
      const url = first(args, 'url')
      let host = url
      try {
        host = url ? new URL(url).host : undefined
      } catch {
        // not a URL: say it as written
      }
      return host ? `Reading ${cut(host, 60)}` : 'Reading a web page'
    }
    case 'task':
    case 'agent': {
      const what = first(args, 'description', 'prompt')
      return what ? `Running an agent: ${cut(what, 70)}` : 'Running an agent'
    }
    case 'todowrite':
    case 'update_plan':
    case 'toolsearch':
    case 'tools-used':
      return undefined
    default:
      return `Using ${tool.split('__').at(-1) ?? tool}`
  }
}

/** Codex's `exec` tool takes a few lines of JavaScript that call its tools (`tools.exec_command({cmd:"..."})`):
 * the first tool call in it, with its plain string arguments, said as any other tool call. */
export function codeDoing(code: string): string | undefined {
  const call = /tools\.([A-Za-z_][A-Za-z0-9_]*)\(\s*(\{[\s\S]*?\})?\s*\)/.exec(code)
  if (!call?.[1]) return 'Running code'
  if (call[1] === 'write_stdin') return 'Waiting for a command to finish'
  const args: Record<string, unknown> = {}
  for (const prop of (call[2] ?? '').matchAll(/([A-Za-z_]\w*)\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      args[prop[1] ?? ''] = JSON.parse(prop[2] ?? '""')
    } catch {
      // a string JSON cannot read: that argument is left out
    }
  }
  return toolDoing(call[1], args)
}

/** Codex's apply_patch text: the files it adds, updates or deletes. */
export function patchDoing(patch: string): string {
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) =>
    baseName((m[1] ?? '').trim()),
  )
  if (!files.length) return 'Editing files'
  return files.length === 1
    ? `Editing ${files[0]}`
    : `Editing ${files[0]} and ${files.length - 1} more`
}

export const THINKING = 'Thinking'
