import { getWidget, rootRequestForWidget } from './catalog'
import type { RootLaunchOptions } from './root-control'
import { isResumeSessionId, launchLine, resumeLaunchLine } from './tui/launch'
import { getTui } from './tui/registry'
import type { TuiSpec } from './tui/spec'

// Prompt bytes exist here only during an exact create/reconcile request (a
// root, or any session Tether restores after a reboot). Once a pane exists its
// immutable gate environment carries launch intent through a crash. No prompt
// is saved in the catalog or sent to a running TUI.
const prompts = new Map<string, string>()
const resumeSessions = new Map<string, string>()
const launchOptions = new Map<string, RootLaunchOptions>()

export async function withRootPrompt<T>(
  widgetId: string,
  prompt: string,
  action: () => Promise<T>,
  resumeSessionId: string | null = null,
  options?: RootLaunchOptions,
): Promise<T> {
  if (
    resumeSessionId !== null &&
    !isResumeSessionId(getTui(getWidget(widgetId)?.tool ?? ''), resumeSessionId)
  )
    throw new Error('invalid resume session')
  prompts.set(widgetId, prompt)
  if (resumeSessionId !== null) resumeSessions.set(widgetId, resumeSessionId)
  if (options) launchOptions.set(widgetId, options)
  try {
    return await action()
  } finally {
    prompts.delete(widgetId)
    resumeSessions.delete(widgetId)
    launchOptions.delete(widgetId)
  }
}

/** A session other than `except` whose launch is resuming this conversation
 * right now, if any. */
export function launchingResume(resumeSessionId: string, except: string): string | null {
  for (const [widgetId, id] of resumeSessions)
    if (id === resumeSessionId && widgetId !== except) return widgetId
  return null
}

/** True while a launch prompt is set for a session that is not a root. */
function plainSessionPrompt(widgetId: string): boolean {
  return prompts.has(widgetId) && !rootRequestForWidget(widgetId)
}

export function rootLaunchEnvironment(widgetId: string): Record<string, string> {
  const root = rootRequestForWidget(widgetId)
  if (!root && !plainSessionPrompt(widgetId)) return {}
  const prompt = prompts.get(widgetId)
  return {
    ...(root ? { ST_SESSION_ID: root.logicalSessionId } : {}),
    // Explicitly clear inherited session variables on a manual replacement.
    AICO_ROOT_INITIAL_LAUNCH: prompt === undefined ? '0' : '1',
    AICO_ROOT_INITIAL_PROMPT: prompt ?? '',
    AICO_ROOT_RESUME_SESSION_ID: resumeSessions.get(widgetId) ?? '',
    AICO_ROOT_MODEL: launchOptions.get(widgetId)?.model ?? '',
    AICO_ROOT_REASONING_EFFORT: launchOptions.get(widgetId)?.reasoningEffort ?? '',
    AICO_ROOT_DAYBREAK: launchOptions.get(widgetId)?.daybreak?.toString() ?? '',
  }
}

/** True while a launch prompt is set for this session (root or not). */
export function hasLaunchPrompt(widgetId: string): boolean {
  return prompts.has(widgetId)
}

export function rootPromptReady(widgetId: string): boolean {
  return !rootRequestForWidget(widgetId) || prompts.has(widgetId)
}

export function initialLaunchLine(widgetId: string, tool: TuiSpec): string | null {
  const line = launchLine(tool)
  if (!line || (!rootRequestForWidget(widgetId) && !plainSessionPrompt(widgetId))) return line
  // Fixed shell bytes, quoted argv expansion. Even control characters and
  // shell metacharacters in the prompt cannot act as gate input or shell code.
  const clean =
    '/usr/bin/env -u AICO_ROOT_INITIAL_PROMPT -u AICO_ROOT_RESUME_SESSION_ID -u AICO_ROOT_MODEL -u AICO_ROOT_REASONING_EFFORT -u AICO_ROOT_DAYBREAK'
  // Fixed adapter flags and quoted environment values. Configure before resume's
  // subcommand so both fresh and resumed native launches receive the overrides.
  const selection = tool.modelSelection
  const flags = selection
    ? `if [ -n "$AICO_ROOT_MODEL" ]; then set -- "$@" ${selection.model.join(' ')} "$AICO_ROOT_MODEL"; fi; if [ -n "$AICO_ROOT_REASONING_EFFORT" ]; then set -- "$@" ${selection.reasoningEffort.arguments.join(' ')} '${selection.reasoningEffort.key}="'"$AICO_ROOT_REASONING_EFFORT"'"'; fi; `
    : ''
  const daybreak = selection?.daybreak
    ? `if [ -n "$AICO_ROOT_DAYBREAK" ]; then set -- "$@" ${selection.daybreak.arguments.join(' ')} "${selection.daybreak.key}=$AICO_ROOT_DAYBREAK"; fi; `
    : ''
  const selected = `${line} "$@"`
  const initial = `${clean} ${selected}`
  const resume = resumeLaunchLine(tool)
  const resumed = resume
    ? `${clean} ${selected} ${tool.resume?.arguments.join(' ')} "$AICO_ROOT_RESUME_SESSION_ID" -- "$AICO_ROOT_INITIAL_PROMPT"`
    : 'exit 64'
  const launch = `if [ -n "$AICO_ROOT_RESUME_SESSION_ID" ]; then ${resumed}; else ${initial} -- "$AICO_ROOT_INITIAL_PROMPT"; fi`
  return `if [ "$AICO_ROOT_INITIAL_LAUNCH" = 1 ]; then set --; ${flags}${daybreak}${launch}; else ${line}; fi`
}
