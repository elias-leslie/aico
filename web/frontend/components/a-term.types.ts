import type { ATermTheme } from '../lib/constants/a-term'

export interface ATermProps {
  sessionId: string
  sessionMode?: string
  workingDir?: string
  className?: string
  onDisconnect?: () => void
  onStatusChange?: (status: ConnectionStatus) => void
  fontFamily?: string
  fontSize?: number
  scrollback?: number
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorBlink?: boolean
  theme?: ATermTheme
  isVisible?: boolean
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
  getContent: () => string
  sendInput: (data: string) => void
  /** Send text wrapped in bracketed paste sequences — needed for TUI apps like Claude Code */
  pasteInput: (data: string) => void
  getLastLine: () => string
  search: (
    query: string,
    options?: ATermSearchOptions,
  ) => ATermSearchResult
  clearSearch: () => void
  status: ConnectionStatus
}
