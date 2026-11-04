// An agent tool's row and the seed each adapter gives for it. A leaf (schema.ts
// holds only constants), so the adapter contract names it without a cycle
// through the registry; tools.ts re-exports it.

import type { CONTEXT_HOOKS } from './schema'

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
