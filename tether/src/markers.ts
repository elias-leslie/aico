// Pane environment markers. These names are a compatibility contract with
// Aico, A-Term, SummitFlow and codex sync (docs/compat-contract.md). Renaming
// any `AICO_*` marker is out of scope.

export const MANAGED_LIFECYCLE_VERSION = 1

export type SessionOrigin = 'aico' | 'a-term' | 'root' | 'cli'

export interface SessionMarkers {
  /** Eight lowercase hex characters; Tether's session ID and Aico's widget ID. */
  id: string
  /** Stable ownership ID (`aico-widget-<id>` for Aico-created sessions). */
  ownershipId: string
  tmuxServerId: string
  projectId: string | null
  tool: string
  /** Set when the session was created from A-Term. */
  aTermSessionId?: string | null
}

/**
 * Variables inherited by the pane, its agent and every tool it launches.
 * `AICO_OWNER=aico` is set on every session because codex sync requires it.
 *
 * `AICO_TMUX_SOCKET` is deliberately absent: Aico reads it as a process-level
 * override of its internal tmux socket, so exporting it into panes would
 * redirect any Aico started from a session. tmux's own `TMUX` variable already
 * names the pane's server socket.
 */
export function paneMarkers(markers: SessionMarkers): Record<string, string> {
  const env: Record<string, string> = {
    AICO_WORKLOAD_CLASS: 'durable-session',
    AICO_OWNER: 'aico',
    AICO_WIDGET_ID: markers.id,
    AICO_SESSION_ID: markers.ownershipId,
    AICO_TMUX_SERVER_ID: markers.tmuxServerId,
    AICO_PROJECT_ID: markers.projectId ?? '',
    AICO_AGENT_SLUG: markers.tool,
    AICO_LIFECYCLE_VERSION: String(MANAGED_LIFECYCLE_VERSION),
  }
  if (markers.aTermSessionId) env.A_TERM_SESSION_ID = markers.aTermSessionId
  return env
}

/** Root launch intent (see Aico root-launch.ts). Prompts are transient. */
export interface RootLaunchMarkers {
  logicalSessionId: string
  initialPrompt: string | null
  resumeSessionId: string | null
}

export function rootMarkers(root: RootLaunchMarkers): Record<string, string> {
  return {
    ST_SESSION_ID: root.logicalSessionId,
    AICO_ROOT_INITIAL_LAUNCH: root.initialPrompt === null ? '0' : '1',
    AICO_ROOT_INITIAL_PROMPT: root.initialPrompt ?? '',
    AICO_ROOT_RESUME_SESSION_ID: root.resumeSessionId ?? '',
  }
}
