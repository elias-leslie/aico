import { getWidget, rootRequestForWidget } from './store'
import { isResumeSessionId, launchLine, resumeLaunchLine } from './tui/launch'
import { getTui } from './tui/registry'
import type { TuiSpec } from './tui/spec'

// Prompt bytes exist here only during an exact create/reconcile request. Once a
// pane exists its immutable gate environment carries launch intent through a
// crash. No prompt is saved in the catalog or sent to a running TUI.
const prompts = new Map<string, string>()
const resumeSessions = new Map<string, string>()

export async function withRootPrompt<T>(
  widgetId: string,
  prompt: string,
  action: () => Promise<T>,
  resumeSessionId: string | null = null,
): Promise<T> {
  if (
    resumeSessionId !== null &&
    !isResumeSessionId(getTui(getWidget(widgetId)?.tool ?? ''), resumeSessionId)
  )
    throw new Error('invalid resume session')
  prompts.set(widgetId, prompt)
  if (resumeSessionId !== null) resumeSessions.set(widgetId, resumeSessionId)
  try {
    return await action()
  } finally {
    prompts.delete(widgetId)
    resumeSessions.delete(widgetId)
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
    AICO_ROOT_RESUME_SESSION_ID: resumeSessions.get(widgetId) ?? '',
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
  const initial = `/usr/bin/env -u AICO_ROOT_INITIAL_PROMPT -u AICO_ROOT_RESUME_SESSION_ID ${line}`
  const resume = resumeLaunchLine(tool)
  const resumed = resume
    ? `/usr/bin/env -u AICO_ROOT_INITIAL_PROMPT -u AICO_ROOT_RESUME_SESSION_ID ${resume} "$AICO_ROOT_RESUME_SESSION_ID" -- "$AICO_ROOT_INITIAL_PROMPT"`
    : 'exit 64'
  const launch = `if [ -n "$AICO_ROOT_RESUME_SESSION_ID" ]; then ${resumed}; else ${initial} -- "$AICO_ROOT_INITIAL_PROMPT"; fi`
  return `if [ "$AICO_ROOT_INITIAL_LAUNCH" = 1 ]; then ${launch}; else ${line}; fi`
}
