'use client'

import { useImperativeHandle } from 'react'
import type {
  ConnectionStatus,
  TerminalHandle,
  TerminalSearchOptions,
  TerminalSearchResult,
} from '../../components/terminal.types'
import {
  getTerminalContent,
  getTerminalLastLine,
} from '../utils/terminal-buffer'
import { useBracketedPaste } from './use-bracketed-paste'

type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>

interface UseTerminalHandleOptions {
  reconnect: () => void
  sendInput: (data: string) => void
  status: ConnectionStatus
  terminalRef: React.RefObject<XtermTerminal | null>
  search: (
    query: string,
    options?: TerminalSearchOptions,
  ) => TerminalSearchResult
  clearSearch: () => void
}

/**
 * Wires the TerminalHandle imperative API exposed to parent components via ref.
 */
export function useTerminalHandle(
  ref: React.Ref<TerminalHandle>,
  {
    reconnect,
    sendInput,
    status,
    terminalRef,
    search,
    clearSearch,
  }: UseTerminalHandleOptions,
): void {
  const pasteInput = useBracketedPaste(sendInput)

  // biome-ignore lint/correctness/useExhaustiveDependencies: terminalRef is a stable ref; .current is read at call time, not depended on for re-creation
  useImperativeHandle(
    ref,
    () => ({
      reconnect,
      getContent: () => getTerminalContent(terminalRef.current),
      getLastLine: () => getTerminalLastLine(terminalRef.current),
      sendInput,
      pasteInput,
      search,
      clearSearch,
      status,
    }),
    [clearSearch, pasteInput, reconnect, search, sendInput, status],
  )
}
