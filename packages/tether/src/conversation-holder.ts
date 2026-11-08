// Who holds a Claude Code or Codex conversation now: Reopen and a kept wake's relaunch both ask
// before starting an agent on it, so two agents never write one transcript.

import { listWidgets } from '@aico/session-engine/catalog'
import { launchingResume } from '@aico/session-engine/root-launch'
import type { Continuity } from './reboot'
import type { Recovery } from './recovery'

/** Nobody can say whether the conversation is free (no observer, or observing failed). */
export class ConversationUnknown extends Error {}

/**
 * A session running, resuming or about to restore this conversation, if any. Read the slow
 * way first (observing every agent may start a crash's recovery), then the quick claims.
 * Throws ConversationUnknown when it can't look: a guess could put two agents on one transcript.
 */
export async function conversationHolder(
  context: { continuity?: Continuity; recovery?: Recovery },
  resumeId: string,
): Promise<string | null> {
  const continuity = context.continuity
  if (!continuity) throw new ConversationUnknown('sessions are not observed here')
  await continuity.restorePlanned
  let observed: Awaited<ReturnType<Continuity['observe']>>
  try {
    observed = await continuity.observe()
  } catch (error) {
    throw new ConversationUnknown(
      `observing sessions failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return (
    observed.find((entry) => entry.resumeId === resumeId)?.row.id ??
    listWidgets().find(
      (row) =>
        continuity.isAwaitingRestore(row.id) &&
        continuity.resumeIdOf(row.id, row.tool) === resumeId,
    )?.id ??
    context.recovery?.resumeOwner(resumeId) ??
    launchingResume(resumeId, '')
  )
}
