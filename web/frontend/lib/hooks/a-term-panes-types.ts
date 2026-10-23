import type { ATermSession } from './use-a-term-sessions'

/** A pane's session: the same full session the Sessions API returns. */
export type PaneSession = ATermSession

export interface ATermPane {
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
  items: ATermPane[]
  total: number
}

export interface CreatePaneRequest {
  pane_type: 'project' | 'adhoc'
  pane_name: string
  project_id?: string
  working_dir?: string
  agent_tool_slug?: string
  detached?: boolean
}

export interface UpdatePaneRequest {
  pane_name?: string
  active_mode?: string
}

export interface PanePlacementOptions {
  detached?: boolean
}
