import { randomUUID } from 'node:crypto'
import { AGENT_SESSION_ENV, FRESH_SESSION_ENV } from '../proc-fs'
import { getLaunchOptions, getWidget, rootRequestForWidget } from './catalog'
import { forWorkspace } from './tui/blank-slate'
import { withInstructions } from './tui/instructions'
import { forRole } from './tui/lane-tools'
import { isResumeSessionId, launchLine, resumeLaunchLine } from './tui/launch'
import { getTui } from './tui/registry'
import type { TuiSpec } from './tui/spec'
import type { RootLaunchOptions } from './types'

/** What a session launches: its tool in its workspace (Blank Slate or not),
 * trimmed to its work role, with its chosen instructions. Every launch path
 * (create, recovery, restart, replacement) and the context check build it here. */
export function sessionSpec<T extends TuiSpec | undefined>(
  spec: T,
  root: string | null | undefined,
  widgetId: string,
): T {
  return withInstructions(
    forRole(forWorkspace(spec, root), rootRequestForWidget(widgetId)?.workRole),
    widgetId,
  )
}

// Prompt bytes exist here only during an exact create/reconcile request (a
// root, or any session Tether restores after a reboot). Once a pane exists its
// immutable gate environment carries launch intent through a crash. No prompt
// is saved in the catalog or sent to a running TUI. A root's explicit launch
// options are (catalog getLaunchOptions), so every later launch of its agent
// (recovery, restart, wake, reboot restore) gets the same model and effort.
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
  const options = launchOptions.get(widgetId) ?? (root ? getLaunchOptions(widgetId) : null)
  return {
    ...(root ? { ST_SESSION_ID: root.logicalSessionId } : {}),
    ST_WORK_ROLE: root?.workRole ?? '',
    ST_WORK_ROLE_SOURCE: root?.workRole ? `tether:root:${root.logicalSessionId}` : '',
    ST_WORK_ROLE_DISPLAY_NAME: root?.workRoleDisplayName ?? '',
    // Explicitly clear inherited session variables on a manual replacement.
    AICO_ROOT_INITIAL_LAUNCH: prompt === undefined ? '0' : '1',
    AICO_ROOT_INITIAL_PROMPT: prompt ?? '',
    AICO_ROOT_RESUME_SESSION_ID: resumeSessions.get(widgetId) ?? '',
    AICO_ROOT_MODEL: options?.model ?? '',
    AICO_ROOT_REASONING_EFFORT: options?.reasoningEffort ?? '',
    AICO_ROOT_DAYBREAK: options?.daybreak?.toString() ?? '',
    // A tool that starts under an ID Tether picks gets a new one per launch,
    // picked here so a host reader knows it wherever the agent runs (an
    // entry's container: continuity.ts findEntryProcess).
    [FRESH_SESSION_ENV]: getTui(getWidget(widgetId)?.tool ?? '')?.resume?.freshArguments
      ? randomUUID()
      : '',
  }
}

/** True while a launch prompt is set for this session (root or not). */
export function hasLaunchPrompt(widgetId: string): boolean {
  return prompts.has(widgetId)
}

export function rootPromptReady(widgetId: string): boolean {
  return !rootRequestForWidget(widgetId) || prompts.has(widgetId)
}

/** Fixed adapter flags from the quoted AICO_ROOT_* values (model, effort,
 * Daybreak), appended to "$@"; empty for a tool without model selection. */
function selectionFlags(tool: TuiSpec): string {
  // Fixed adapter flags and quoted environment values. Configure before resume's
  // subcommand so both fresh and resumed native launches receive the overrides.
  const selection = tool.modelSelection
  const effort = selection?.reasoningEffort
  const effortValue = effort?.key
    ? `'${effort.key}="'"$AICO_ROOT_REASONING_EFFORT"'"'`
    : '"$AICO_ROOT_REASONING_EFFORT"'
  const modelFlags = selection?.modelProvider
    ? `${selection.modelProvider.join(' ')} "\${AICO_ROOT_MODEL%%/*}" ${selection.model.join(' ')} "\${AICO_ROOT_MODEL#*/}"`
    : `${selection?.model.join(' ')} "$AICO_ROOT_MODEL"`
  const flags = selection
    ? `if [ -n "$AICO_ROOT_MODEL" ]; then set -- "$@" ${modelFlags}; fi; ` +
      (effort
        ? `if [ -n "$AICO_ROOT_REASONING_EFFORT" ]; then set -- "$@" ${effort.arguments.join(' ')} ${effortValue}; fi; `
        : '')
    : ''
  const daybreak =
    selection?.daybreak && 'arguments' in selection.daybreak
      ? `if [ -n "$AICO_ROOT_DAYBREAK" ]; then set -- "$@" ${selection.daybreak.arguments.join(' ')} "${selection.daybreak.key}=$AICO_ROOT_DAYBREAK"; fi; `
      : ''
  return `${flags}${daybreak}`
}

/** Prompt bytes are always removed; other tools receive no Pi metadata. */
function cleanEnvironment(tool: TuiSpec): string {
  return (
    `/usr/bin/env -u AICO_ROOT_INITIAL_PROMPT -u AICO_ROOT_RESUME_SESSION_ID -u ${FRESH_SESSION_ENV} -u AICO_ROOT_REASONING_EFFORT` +
    (tool.environmentSelection ? '' : ' -u AICO_ROOT_MODEL -u AICO_ROOT_DAYBREAK')
  )
}

/** `TETHER_AGENT_SESSION_ID=<id>; ` for a tool that starts under an ID
 * Tether picks: the resume id when `resume` (an initial launch), else the
 * host's fresh id, else one picked where the line runs. continuity.ts
 * `chosenSessionId` reads the same variables back from the entry process. */
function chooseSession(resume: boolean): string {
  const fresh = `\${${FRESH_SESSION_ENV}:-$(cat /proc/sys/kernel/random/uuid)}`
  const value = resume ? `\${AICO_ROOT_RESUME_SESSION_ID:-${fresh}}` : fresh
  return `${AGENT_SESSION_ENV}="${value}"; `
}

/** The agent's launch with no launch prompt (restart, a wake or reboot with
 * nothing to resume): plain, unless the root was created with explicit
 * launch options, which it then gets again. A root whose tool starts under an
 * ID Tether picks (Pi) starts a new conversation under the launch's fresh ID,
 * so it stays found (and resumable) after the restart. */
export function relaunchLine(widgetId: string, tool: TuiSpec): string | null {
  const line = launchLine(tool)
  if (!line || !rootRequestForWidget(widgetId)) return line
  const fresh = tool.resume?.freshArguments
  const options = Boolean(tool.modelSelection && getLaunchOptions(widgetId))
  if (!options && !fresh) return line
  const selection = options ? selectionFlags(tool) : ''
  if (!fresh) return `set --; ${selection}${cleanEnvironment(tool)} ${line} "$@"`
  return `set --; ${selection}${chooseSession(false)}${cleanEnvironment(tool)} ${AGENT_SESSION_ENV}="$${AGENT_SESSION_ENV}" ${line} "$@" ${fresh.join(' ')} "$${AGENT_SESSION_ENV}"`
}

export function initialLaunchLine(widgetId: string, tool: TuiSpec): string | null {
  const line = launchLine(tool)
  if (!line || (!rootRequestForWidget(widgetId) && !plainSessionPrompt(widgetId))) return line
  // Fixed shell bytes, quoted argv expansion. Even control characters and
  // shell metacharacters in the prompt cannot act as gate input or shell code.
  // Pi's native extension consumes only the explicit per-session selection.
  const clean = cleanEnvironment(tool)
  const selection = selectionFlags(tool)
  const missing = (tool.ensureArgs ?? []).filter((arg) => !tool.command.includes(arg))
  const projectTrust = missing.length ? `set -- "$@" ${missing.join(' ')}; ` : ''
  // A tool that keeps no observable session record starts under an ID Tether
  // picks; the agent's environment carries it so continuity can read it.
  const fresh = tool.resume?.freshArguments
  const chosen = fresh ? chooseSession(true) : ''
  const agentEnv = fresh ? ` ${AGENT_SESSION_ENV}="$${AGENT_SESSION_ENV}"` : ''
  const selected = `${line} "$@"`
  const initial = `${clean}${agentEnv} ${selected}${fresh ? ` ${fresh.join(' ')} "$${AGENT_SESSION_ENV}"` : ''}`
  const resume = resumeLaunchLine(tool)
  const promptFlag = (tool.resume?.promptArguments ?? ['--']).join(' ')
  const resumed = resume
    ? `${clean}${agentEnv} ${selected} ${tool.resume?.arguments.join(' ')} "$AICO_ROOT_RESUME_SESSION_ID" ${promptFlag} "$AICO_ROOT_INITIAL_PROMPT"`
    : 'exit 64'
  const launch = `if [ -n "$AICO_ROOT_RESUME_SESSION_ID" ]; then ${resumed}; else ${initial} ${promptFlag} "$AICO_ROOT_INITIAL_PROMPT"; fi`
  return `if [ "$AICO_ROOT_INITIAL_LAUNCH" = 1 ]; then set --; ${selection}${projectTrust}${chosen}${launch}; else ${relaunchLine(widgetId, tool)}; fi`
}
