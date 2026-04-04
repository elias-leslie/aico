export interface PaneSession {
  id: string
  name: string
  mode: string
  session_number: number
  is_alive: boolean
  working_dir: string | null
  claude_state: 'not_started' | 'starting' | 'running' | 'stopped' | 'error'
}

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
}

export interface UpdatePaneRequest {
  pane_name?: string
  active_mode?: string
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
