// Supplemental-context installation checks. `ensureContext` dispatches on the
// declarative hook `kind` to a handler implemented ONCE here and shared by every
// TUI that declares that kind. The checks themselves are in the tools' adapters
// (adapters/); this module only dispatches and words the Blank Slate answers.

import { adapterForContext } from './registry'
import type { ContextHook, ContextStatus, TuiSpec } from './spec'

const BLANK_SLATE_STATUS: ContextStatus = {
  state: 'not_applicable',
  detail:
    'Blank Slate: no Agent Hub, project, memory, skill, plugin, MCP or launch-hook context is added.',
}

/** The status with the session's chosen instructions named, if it has some. */
function withChosen(spec: TuiSpec, status: ContextStatus): ContextStatus {
  const chosen = spec.chosenInstructions
  if (!chosen) return status
  if (spec.context?.kind === 'blank-slate')
    return {
      state: status.state,
      detail: `Blank Slate with chosen instructions ${chosen.label}; no Agent Hub, project, memory, skill, plugin, MCP or launch-hook context is added.`,
    }
  return { state: status.state, detail: `${status.detail}. Chosen instructions: ${chosen.label}.` }
}

/** The answer for a TUI with no context hook, known without probing. */
export function staticContextStatus(spec: TuiSpec): ContextStatus | null {
  if (spec.context?.kind === 'blank-slate') return withChosen(spec, BLANK_SLATE_STATUS)
  if (spec.context) return null
  return spec.command.length
    ? {
        state: 'unsupported',
        detail: 'No canonical context adapter is registered; native agent continues.',
      }
    : { state: 'not_applicable', detail: 'A bare shell has no model context.' }
}

/** Check installation availability only; model receipt is unverified.
 * The result drives visible status and never gates pane dispatch. */
export async function ensureContext(spec: TuiSpec): Promise<ContextStatus> {
  const fixed = staticContextStatus(spec)
  if (fixed || !spec.context) return fixed as ContextStatus
  return withChosen(spec, await probeHook(spec, spec.context))
}

async function probeHook(spec: TuiSpec, context: ContextHook): Promise<ContextStatus> {
  if (context.kind === 'blank-slate') return BLANK_SLATE_STATUS
  const adapter = adapterForContext(context.kind)
  return adapter
    ? adapter.context.check(spec)
    : { state: 'unsupported', detail: `No adapter checks the ${context.kind} context hook.` }
}

/** Run only after Tether has retired the exact owned workload. */
export function finalizeContext(
  spec: TuiSpec | undefined,
  ownershipId: string,
): Promise<boolean | null> {
  const kind = spec?.context?.kind
  const retire = kind ? adapterForContext(kind)?.context.retire : undefined
  return retire ? retire(ownershipId) : Promise.resolve(null)
}
