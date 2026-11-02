// Merged agent-tool registry: the declarative TUI specs that came from the retired
// Aico desktop app, reconciled with the old web backend's agent_tools rows.

import { ADAPTERS } from './lifecycle/tui/registry'
import { CONTEXT_HOOKS } from './schema'

export type ContextHook = (typeof CONTEXT_HOOKS)[number]

export interface AgentTool {
  id: string
  slug: string
  name: string
  argv: string[]
  /** Shell-quoted rendering of argv, for the web app's string `command` field. */
  command: string
  processName: string
  description: string | null
  color: string | null
  displayOrder: number
  isDefault: boolean
  enabled: boolean
  /** Other slugs that resolve to this tool (the web app's `claude` → `claude-code`). */
  aliases: string[]
  contextHook: ContextHook | null
  createdAt: number
  updatedAt: number
}

export type ToolSeed = Omit<AgentTool, 'id' | 'command' | 'createdAt' | 'updatedAt'>

/**
 * Seeded once when the database is created. Each agent tool's row comes from
 * its adapter (lifecycle/tui/adapters): canonical slugs follow Aico (widget
 * rows and the root contract use `claude-code`), the web app's `claude` slug
 * is an alias, and Codex is the default (owner decision 2026-10-10). Colours
 * are Aico's titlebar accents.
 */
export const DEFAULT_TOOLS: readonly ToolSeed[] = [
  ...ADAPTERS.map((adapter) => adapter.seed),
  {
    // The Agent Hub chat: no command and no terminal (see AGENT_HUB_TOOL). The
    // name here is the one label every Aico screen shows for it.
    slug: 'agent-hub',
    name: 'Agent Hub',
    argv: [],
    processName: '',
    description: 'Any model',
    color: '#7C83F6',
    displayOrder: 4,
    isDefault: false,
    enabled: true,
    aliases: [],
    contextHook: null,
  },
  {
    slug: 'shell',
    name: 'Shell',
    argv: [],
    processName: '',
    description: 'Interactive login shell with no agent',
    color: '#8A8F98',
    displayOrder: 9,
    isDefault: false,
    enabled: true,
    aliases: [],
    contextHook: null,
  },
].sort((a, b) => a.displayOrder - b.displayOrder)

export const SLUG_RE = /^[a-z0-9_-]{1,50}$/
const SAFE_WORD_RE = /^[A-Za-z0-9_@%+=:,./-]+$/
const MAX_ARGV = 32
const MAX_ARG_BYTES = 512

export class ToolValidationError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/**
 * Parse the web app's string `command` into argv. Only whitespace-separated plain
 * words are accepted: no quotes, expansions, globs, redirections or control
 * operators, so the stored argv is exactly what the operator typed.
 */
export function parseCommand(command: string): string[] {
  const words = command
    .trim()
    .split(/[ \t]+/)
    .filter(Boolean)
  if (words.some((word) => !SAFE_WORD_RE.test(word))) {
    throw new ToolValidationError('invalid_command')
  }
  return validateArgv(words)
}

export function validateArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length > MAX_ARGV) throw new ToolValidationError('invalid_argv')
  for (const arg of argv) {
    if (
      typeof arg !== 'string' ||
      arg.length === 0 ||
      Buffer.byteLength(arg) > MAX_ARG_BYTES ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
      /[\u0000-\u001f\u007f]/.test(arg)
    ) {
      throw new ToolValidationError('invalid_argv')
    }
  }
  return argv as string[]
}

function shellQuote(value: string): string {
  return SAFE_WORD_RE.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`
}

export function formatCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}

export function isContextHook(value: unknown): value is ContextHook {
  return typeof value === 'string' && (CONTEXT_HOOKS as readonly string[]).includes(value)
}
