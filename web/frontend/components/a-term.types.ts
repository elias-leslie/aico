export interface ATermProps {
  sessionId: string
  sessionMode?: string
  workingDir?: string
  className?: string
  onDisconnect?: () => void
  onStatusChange?: (status: ConnectionStatus) => void
  fontSize?: number
  isVisible?: boolean
  onFilePaste?: (file: File, sessionId: string) => void | Promise<void>
  /** Another device holds the shared size: its name, or null when this view does. */
  onSizeHolderChange?: (holder: string | null) => void
}

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'session_dead'
  | 'timeout'

export type ATermSearchDirection = 'next' | 'previous'

export interface ATermSearchOptions {
  direction?: ATermSearchDirection
  reset?: boolean
}

export interface ATermSearchResult {
  query: string
  totalMatches: number
  activeIndex: number
  found: boolean
}

export interface ATermHandle {
  reconnect: () => void
  /** Take the shared size for this view ("Use here"). */
  claimSize: () => void
  getContent: () => string
  sendInput: (data: string) => void
  /** Send text wrapped in bracketed paste sequences — needed for TUI apps like Claude Code */
  pasteInput: (data: string) => Promise<void>
  search: (query: string, options?: ATermSearchOptions) => ATermSearchResult
  clearSearch: () => void
  status: ConnectionStatus
}
