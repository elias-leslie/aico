// Aico enumerated TUIs in code (electron/main/tui/registry.ts + tuis/*). In
// Tether the merged `agent_tools` table is the registry; this module adapts a
// tool row to the engine's pure-data TuiSpec. Resume adapters stay code, keyed
// by canonical slug, and can never be edited through the API.

import type { AgentTool, ContextHook as ToolContextHook } from '../../tools'
import type { ContextHook, TuiSpec } from './spec'

/** Native resume adapters (Aico tuis/codex.ts). Code, not data. */
export const RESUME_ADAPTERS: Readonly<Record<string, NonNullable<TuiSpec['resume']>>> = {
  codex: {
    sessionIdPattern: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    arguments: ['resume', '--no-daemon'],
  },
  'claude-code': {
    sessionIdPattern: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    arguments: ['--resume'],
  },
  pi: {
    sessionIdPattern: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    arguments: ['--session'],
  },
}

/** Tools Tether can start as a root: exactly the slugs with a resume adapter,
 * since a root must be resumable after a crash. Canonical slugs only, as the
 * root digest covers the tool string as sent. */
export const ROOT_TOOLS: readonly string[] = Object.keys(RESUME_ADAPTERS).sort()

export function isRootTool(slug: unknown): slug is string {
  return typeof slug === 'string' && Object.hasOwn(RESUME_ADAPTERS, slug)
}

function contextHook(hook: ToolContextHook | null): ContextHook | undefined {
  switch (hook) {
    case 'claude-session-start':
      return { kind: 'claude-session-start' }
    case 'codex-hooks':
      return { kind: 'codex-hooks' }
    case 'pi-extension':
      return { kind: 'pi-extension' }
    case 'canonical-retrieval:antigravity':
      return { kind: 'canonical-retrieval', surface: 'antigravity' }
    default:
      return undefined
  }
}

export function toolSpec(tool: AgentTool): TuiSpec {
  const spec: TuiSpec = {
    slug: tool.slug,
    displayName: tool.name,
    icon: '',
    accent: tool.color ?? '',
    order: tool.displayOrder,
    enabled: tool.enabled,
    command: [...tool.argv],
    processName: tool.processName,
  }
  const context = contextHook(tool.contextHook)
  if (context) spec.context = context
  const resume = RESUME_ADAPTERS[tool.slug]
  if (resume) spec.resume = resume
  if (tool.slug === 'codex')
    spec.modelSelection = {
      model: ['--model'],
      reasoningEffort: { arguments: ['-c'], key: 'model_reasoning_effort' },
      daybreak: { arguments: ['-c'], key: 'daybreak' },
    }
  if (tool.slug === 'pi')
    spec.modelSelection = {
      model: ['--model'],
      modelProvider: ['--provider'],
      reasoningEffort: { arguments: ['--thinking'] },
      daybreak: { environment: true },
    }
  return spec
}

export interface ToolSource {
  /** Exact slug or alias. */
  resolveTool(slugOrAlias: string): AgentTool | undefined
  defaultTool(): AgentTool | undefined
  listTools(options?: { enabledOnly?: boolean }): AgentTool[]
}

let source: ToolSource | null = null

/** The daemon binds its Store once; tests bind a fake. */
export function bindToolSource(next: ToolSource | null): void {
  source = next
}

/** Resolve a stored slug (or alias) to its spec. Disabled tools still resolve,
 * as Aico's `getTui` did, so existing sessions keep their launch command. */
export function getTui(slug: string): TuiSpec | undefined {
  const tool = source?.resolveTool(slug)
  return tool ? toolSpec(tool) : undefined
}

/** Canonical slug for a slug or alias, or undefined. */
export function canonicalToolSlug(slug: string): string | undefined {
  return source?.resolveTool(slug)?.slug
}

export function listTuis(): TuiSpec[] {
  return (source?.listTools({ enabledOnly: true }) ?? []).map(toolSpec)
}

export function defaultTui(): TuiSpec {
  const tool = source?.defaultTool()
  if (!tool) throw new Error('no agent tools registered')
  return toolSpec(tool)
}
