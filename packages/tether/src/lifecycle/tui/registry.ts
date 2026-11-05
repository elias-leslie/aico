// The registry of agent TUIs. Each tool is one adapter (adapters/, contract in
// adapters/contract.ts); this module lists them, answers every question that
// used to branch on a tool's name, and adapts an `agent_tools` row to the
// engine's pure-data TuiSpec. The adapters are code and can never be edited
// through the API; the table holds the operator's command, colour and order.

import type { AgentTool, ContextHook as ToolContextHook } from '../../tools'
import { agy } from './adapters/agy'
import { aicoAgent } from './adapters/aico-agent'
import { claudeCode } from './adapters/claude-code'
import { codex } from './adapters/codex'
import type { TuiAdapter } from './adapters/contract'
import { pi } from './adapters/pi'
import type { ContextHook, TuiSpec } from './spec'

/** Every agent TUI Tether knows, one adapter each (adapters/contract.ts), in the
 * order an agent is looked for in a pane's processes. The Aico agent comes before
 * Pi: both start under TETHER_AGENT_SESSION_ID, and Pi's search does not check the
 * process name. */
export const ADAPTERS: readonly TuiAdapter[] = [claudeCode, codex, aicoAgent, pi, agy]

/** The adapter of a canonical tool slug. */
export function adapterOf(slug: unknown): TuiAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.id === slug)
}

/** The adapter a harness name (`claude`, as its hooks and the model watch say it) belongs to. */
export function adapterByHarness(harness: unknown): TuiAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.harness === harness)
}

/** The adapter that checks a context hook kind. */
export function adapterForContext(kind: ContextHook['kind']): TuiAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.context.kind.kind === kind)
}

/** How each tool takes a session's chosen instructions on top of its own
 * prompt. The Agent Hub launchers merge these with the context they deliver. */
export function supportsInstructions(slug: string): boolean {
  return adapterOf(slug)?.capabilities.instructions ?? false
}

/** Tools Tether can start as a root: exactly the slugs with a resume adapter,
 * since a root must be resumable after a crash. Canonical slugs only, as the
 * root digest covers the tool string as sent. */
export const ROOT_TOOLS: readonly string[] = ADAPTERS.filter((adapter) => adapter.capabilities.root)
  .map((adapter) => adapter.id)
  .sort()

export function isRootTool(slug: unknown): slug is string {
  return adapterOf(slug)?.capabilities.root ?? false
}

/** Every root uses a resumable adapter. */
export const ROOT_CREATE_TOOLS = ROOT_TOOLS
export const isRootCreateTool = isRootTool

/** Pane tools Tether delivers event lines to (lane reports, waits, deliveries)
 * by its gated paste. */
export function isDeliveryTool(slug: unknown): slug is string {
  return adapterOf(slug)?.capabilities.delivery.idlePaste ?? false
}

function contextHook(hook: ToolContextHook | null): ContextHook | undefined {
  return ADAPTERS.find((adapter) => adapter.seed.contextHook === hook)?.context.kind
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
  const adapter = adapterOf(tool.slug)
  if (adapter) {
    Object.assign(spec, adapter.spec)
    if (adapter.launch.ensureArgs.length) spec.ensureArgs = adapter.launch.ensureArgs
    if (adapter.capabilities.environmentSelection) spec.environmentSelection = true
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

export function listTuis(): TuiSpec[] {
  return (source?.listTools({ enabledOnly: true }) ?? []).map(toolSpec)
}

/** Process names (comm) of every agent tool, disabled ones included since
 * their sessions keep running; a shell has none. */
export function agentProcessNames(): ReadonlySet<string> {
  return new Set(
    (source?.listTools() ?? []).flatMap((tool) =>
      tool.argv.length && tool.processName ? [tool.processName] : [],
    ),
  )
}

export function defaultTui(): TuiSpec {
  const tool = source?.defaultTool()
  if (!tool) throw new Error('no agent tools registered')
  return toolSpec(tool)
}
