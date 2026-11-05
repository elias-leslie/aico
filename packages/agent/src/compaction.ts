// Pi's compaction, unchanged. prepareCompaction and estimateContextTokens are not in
// pi-coding-agent's package exports, so they are imported from its installed compaction
// module by path (the package is exact-pinned); compact() and the context builder come
// from the package itself. When and how it runs follows Pi's AgentSession: before a
// prompt and before each next response when the context is over the threshold, after a
// response that overflowed (compact, then retry once).

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  buildSessionContext,
  type compact,
  type DEFAULT_COMPACTION_SETTINGS,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'

/** Pi's compaction settings (when, and how much recent context it keeps). */
export type CompactionSettings = typeof DEFAULT_COMPACTION_SETTINGS
type Preparation = Parameters<typeof compact>[0]

interface PiCompactionModule {
  prepareCompaction(entries: SessionEntry[], settings: CompactionSettings): Preparation | undefined
  estimateContextTokens(messages: AgentMessage[]): { tokens: number }
}

let loaded: Promise<PiCompactionModule> | undefined

export function piCompaction(): Promise<PiCompactionModule> {
  loaded ??= import(
    /* @vite-ignore */ new URL(
      './core/compaction/compaction.js',
      import.meta.resolve('@earendil-works/pi-coding-agent'),
    ).href
  ) as Promise<PiCompactionModule>
  return loaded
}

/** What the model sees for these entries: Pi's session context (the newest compaction's
 * summary, then what it kept), without failed responses, which are never sent. */
export function contextMessages(entries: SessionEntry[]): AgentMessage[] {
  return buildSessionContext(entries).messages.filter(
    (message) =>
      message.role !== 'assistant' ||
      (message.stopReason !== 'error' && message.stopReason !== 'aborted'),
  )
}
