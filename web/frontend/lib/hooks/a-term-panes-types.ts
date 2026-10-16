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
  max_panes: number
}

export interface PaneCountResponse {
  count: number
  max_panes: number
  at_limit: boolean
}

export interface CreatePaneRequest {
  pane_type: 'project' | 'adhoc'
  pane_name: string
  project_id?: string
  working_dir?: string
  agent_tool_slug?: string
  detached?: boolean
  pane_order?: number
  width_percent?: number
  height_percent?: number
  grid_row?: number
  grid_col?: number
}

export interface UpdatePaneRequest {
  pane_name?: string
  active_mode?: string
}

export interface AttachPaneRequest {
  pane_order?: number
  width_percent?: number
  height_percent?: number
  grid_row?: number
  grid_col?: number
}

export interface PanePlacementOptions {
  detached?: boolean
  paneOrder?: number
  widthPercent?: number
  heightPercent?: number
  gridRow?: number
  gridCol?: number
}

export interface SwapPanesRequest {
  pane_id_a: string
  pane_id_b: string
}

export interface PaneLayoutItem {
  pane_id: string
  width_percent?: number
  height_percent?: number
}

export interface BulkLayoutUpdateRequest {
  layouts: PaneLayoutItem[]
}
