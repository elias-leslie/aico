// New session, Agent Hub chat kind. A chat has no terminal, so it does not
// open a window first and wait for a grid size: Tether creates the chat at
// once (agent and model are Tether's defaults, changed in the chat itself) and
// the window opens on the new session. A refusal is told in a message, since
// there is no window yet to hold a notice.

import type { SessionCatalog, SessionDescriptor, TetherClient } from 'tether/client'
import { describeFailure } from './notices'
import { BLANK_SLATE_ID, PERSONAL_WORKSPACE_ID } from './project'

/** Tether's slug for the Agent Hub chat tool. */
export const CHAT_TOOL = 'agent-hub'

/** A chat runs in a registered project; the made-up workspaces are not one. */
const NOT_PROJECTS = new Set([BLANK_SLATE_ID, PERSONAL_WORKSPACE_ID])

interface ChatLaunchDeps {
  tether: Pick<TetherClient, 'createSession'>
  catalog: Pick<SessionCatalog, 'upsert'>
  /** Bring the session's window forward, opening it if needed. */
  show(id: string): void
  /** Tell the owner why no chat opened. */
  fail(message: string): void
  /** Size the session is created at; a chat ignores it. */
  size?: { cols: number; rows: number }
}

export function createChatLauncher(deps: ChatLaunchDeps) {
  const size = deps.size ?? { cols: 100, rows: 30 }
  return async function launchChat(projectId: string): Promise<void> {
    if (NOT_PROJECTS.has(projectId)) {
      deps.fail('Pick a project: a chat runs in a project Agent Hub knows.')
      return
    }
    let created: SessionDescriptor
    try {
      created = await deps.tether.createSession({ tool: CHAT_TOOL, projectId, size })
    } catch (error) {
      deps.fail(describeFailure('Could not start the chat', error))
      return
    }
    deps.catalog.upsert(created)
    deps.show(created.id)
  }
}
