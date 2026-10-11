// Merged agent-tool registry: Aico's declarative TUI specs (electron/main/tui/
// tuis/*) reconciled with A-Term's live agent_tools rows. Editing the registry
// from either app changes launches in both.

import { CONTEXT_HOOKS } from './schema'

export type ContextHook = (typeof CONTEXT_HOOKS)[number]

export interface AgentTool {
  id: string
  slug: string
  name: string
  argv: string[]
  /** Shell-quoted rendering of argv, for A-Term's string `command` field. */
  command: string
  processName: string
  description: string | null
  color: string | null
  displayOrder: number
  isDefault: boolean
  enabled: boolean
  /** Other slugs that resolve to this tool (A-Term's `claude` → `claude-code`). */
  aliases: string[]
  contextHook: ContextHook | null
  createdAt: number
  updatedAt: number
}

export type ToolSeed = Omit<AgentTool, 'id' | 'command' | 'createdAt' | 'updatedAt'>

/**
 * Seeded once when the database is created. Canonical slugs follow Aico
 * (widget rows and the root contract use `claude-code`); A-Term's `claude`
 * slug is an alias. Codex is the default (owner decision 2026-10-10).
 * Colours are Aico's titlebar accents; descriptions come from A-Term rows.
 * Pi keeps Aico's `--approve`, which removes Pi's project-trust prompt in this
 * operator-owned workspace; A-Term's bare `pi` predates it.
 */
export const DEFAULT_TOOLS: readonly ToolSeed[] = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    argv: ['claude', '--dangerously-skip-permissions'],
    processName: 'claude',
    description: 'Anthropic Claude Code coding agent',
    color: '#D97757',
    displayOrder: 0,
    isDefault: false,
    enabled: true,
    aliases: ['claude'],
    contextHook: 'claude-session-start',
  },
  {
    slug: 'codex',
    name: 'Codex',
    argv: ['codex', '--yolo'],
    processName: 'codex',
    description: 'OpenAI Codex coding agent',
    color: '#9B8CFF',
    displayOrder: 1,
    isDefault: true,
    enabled: true,
    aliases: [],
    contextHook: 'codex-hooks',
  },
  {
    slug: 'agy',
    name: 'Antigravity',
    argv: ['agy', '--dangerously-skip-permissions'],
    processName: 'agy',
    description: 'Google Antigravity terminal coding agent',
    color: '#3186FF',
    displayOrder: 2,
    isDefault: false,
    enabled: true,
    aliases: [],
    contextHook: 'canonical-retrieval:antigravity',
  },
  {
    slug: 'pi',
    name: 'Pi',
    argv: ['pi', '--approve'],
    processName: 'pi-coding-agent',
    description: 'Pi coding agent',
    color: '#C16A8A',
    displayOrder: 3,
    isDefault: false,
    enabled: true,
    aliases: [],
    contextHook: 'pi-extension',
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
]

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
 * Parse A-Term's string `command` into argv. Only whitespace-separated plain
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
