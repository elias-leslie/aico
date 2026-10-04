import { rootRequestForWidget } from './store'
import { launchLine } from './tui/launch'
import type { TuiSpec } from './tui/spec'

// Prompt bytes exist here only during an exact create/reconcile request. Once a
// pane exists its immutable gate environment carries launch intent through a
// crash. No prompt is saved in the catalog or sent to a running TUI.
const prompts = new Map<string, string>()

export async function withRootPrompt<T>(
  widgetId: string,
  prompt: string,
  action: () => Promise<T>,
): Promise<T> {
  prompts.set(widgetId, prompt)
  try {
    return await action()
  } finally {
    prompts.delete(widgetId)
  }
}

export function rootLaunchEnvironment(widgetId: string): Record<string, string> {
  const root = rootRequestForWidget(widgetId)
  if (!root) return {}
  const prompt = prompts.get(widgetId)
  return {
    ST_SESSION_ID: root.logicalSessionId,
    // Explicitly clear inherited session variables on a manual replacement.
    AICO_ROOT_INITIAL_LAUNCH: prompt === undefined ? '0' : '1',
    AICO_ROOT_INITIAL_PROMPT: prompt ?? '',
  }
}

export function rootPromptReady(widgetId: string): boolean {
  return !rootRequestForWidget(widgetId) || prompts.has(widgetId)
}

export function initialLaunchLine(widgetId: string, tool: TuiSpec): string | null {
  const line = launchLine(tool)
  if (!line || !rootRequestForWidget(widgetId)) return line
  // Fixed shell bytes, quoted argv expansion. Even control characters and
  // shell metacharacters in the prompt cannot act as gate input or shell code.
  return `if [ "$AICO_ROOT_INITIAL_LAUNCH" = 1 ]; then /usr/bin/env -u AICO_ROOT_INITIAL_PROMPT ${line} -- "$AICO_ROOT_INITIAL_PROMPT"; else ${line}; fi`
}
