import type { TerminalTheme } from '../lib/constants/terminal'

export interface TerminalProps {
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
  theme?: TerminalTheme
  isVisible?: boolean
}

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'session_dead'
  | 'timeout'

export type TerminalSearchDirection = 'next' | 'previous'

export interface TerminalSearchOptions {
  direction?: TerminalSearchDirection
  reset?: boolean
}

export interface TerminalSearchResult {
  query: string
  totalMatches: number
  activeIndex: number
  found: boolean
}

export interface TerminalHandle {
  reconnect: () => void
  getContent: () => string
  sendInput: (data: string) => void
  /** Send text wrapped in bracketed paste sequences — needed for TUI apps like Claude Code */
  pasteInput: (data: string) => void
  getLastLine: () => string
  search: (
    query: string,
    options?: TerminalSearchOptions,
  ) => TerminalSearchResult
  clearSearch: () => void
  status: ConnectionStatus
}
