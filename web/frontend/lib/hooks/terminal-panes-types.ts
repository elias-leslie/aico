import type { TerminalSession } from './use-terminal-sessions'

/** A pane's session: the same full session the Sessions API returns. */
export type PaneSession = TerminalSession

export interface TerminalPane {
  id: string
  pane_type: 'project' | 'adhoc'
  project_id: string | null
  pane_order: number
  pane_name: string
  active_mode: string
  is_detached: boolean
  created_at: string | null
  sessions: PaneSession[]
  width_percent: number
  height_percent: number
  grid_row: number
  grid_col: number
}

export interface PaneListResponse {
  items: TerminalPane[]
  total: number
}

export interface CreatePaneRequest {
  pane_type: 'project' | 'adhoc'
  pane_name: string
  project_id?: string
  working_dir?: string
  agent_tool_slug?: string
  detached?: boolean
  /** A Tether peer to start the session on; absent for this computer. */
  host?: string
}

export interface UpdatePaneRequest {
  pane_name?: string
  active_mode?: string
}

export interface PanePlacementOptions {
  detached?: boolean
  host?: string
}
