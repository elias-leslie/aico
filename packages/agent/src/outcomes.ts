// Typed outcomes of one provider response: a safety refusal (the next model in the
// role's chain takes over) or a model swap (the provider answered with another model
// than the one asked for; the run stops so nothing runs on a model the rules didn't pick).

import type { AssistantMessage } from '@earendil-works/pi-ai'
import { HARNESS, type Harness } from './rules'

export interface ModelRefusal {
  kind: 'refusal'
  /** cyber, bio, misalignment, too_many_denials, or the provider's stop reason. */
  category: string
  detail: string
}

export interface ModelSwap {
  kind: 'model_swap'
  requested: string
  served: string
}

/** Lower case without `_` and `-`, so cyberPolicy, cyber_policy and cyber-policy match. */
const normal = (value: string) => value.replace(/[_-]/g, '').toLowerCase()

/**
 * The refusal in a failed response, or null when it failed for another reason (or did not
 * fail). Only structured signals count: the provider's raw stop reason (incomplete.content_filter),
 * an error that starts with a refusal code (`cyber_policy: ...`, `Error Code cyberPolicy: ...`)
 * or names an incomplete response's reason (`Response incomplete: content_filter`). The bare
 * words "safety" or "refusal" elsewhere in an error are not a refusal.
 */
export function refusalOf(
  message: AssistantMessage,
  harness: Harness = HARNESS,
): ModelRefusal | null {
  if (message.stopReason !== 'error') return null
  const detail = message.errorMessage ?? message.rawStopReason ?? ''
  const codes = harness.refusal_codes as Record<string, string>
  const stops = new Set(harness.refusal_stop_reasons.map(normal))
  const stopCategory = (word: string) => (stops.has(normal(word)) ? word : undefined)
  for (const part of (message.rawStopReason ?? '').split(/[^A-Za-z0-9_-]+/)) {
    const category = codes[normal(part)] ?? stopCategory(part)
    if (category) return { kind: 'refusal', category, detail }
  }
  const error = message.errorMessage ?? ''
  const code = /^\s*(?:error code\s+)?([A-Za-z_-]+)\s*(?::|$)/i.exec(error)?.[1]
  const coded = code ? codes[normal(code)] : undefined
  if (coded) return { kind: 'refusal', category: coded, detail }
  const incomplete = /^\s*response incomplete:\s*([A-Za-z_-]+)\s*$/i.exec(error)?.[1]
  const stopped = incomplete ? stopCategory(incomplete) : undefined
  if (stopped) return { kind: 'refusal', category: stopped, detail }
  return null
}

/** A model id without its provider prefix or a trailing date (gpt-6.1-sol-2026-10-01 is gpt-6.1-sol). */
function bareModel(id: string): string {
  const name = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
  return name.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, '')
}

/** The swap when the response names a different model than the request. */
export function swapOf(message: AssistantMessage, requested: string): ModelSwap | null {
  const served = message.responseModel
  if (!served || bareModel(served) === bareModel(requested)) return null
  return { kind: 'model_swap', requested, served }
}
