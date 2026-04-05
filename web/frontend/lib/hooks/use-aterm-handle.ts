'use client'

import { useImperativeHandle } from 'react'
import type {
  ConnectionStatus,
  ATermHandle,
  ATermSearchOptions,
  ATermSearchResult,
} from '../../components/aterm.types'
import {
  getATermContent,
  getATermLastLine,
} from '../utils/aterm-buffer'
import { useBracketedPaste } from './use-bracketed-paste'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

interface UseATermHandleOptions {
  reconnect: () => void
  sendInput: (data: string) => void
  status: ConnectionStatus
  atermRef: React.RefObject<XtermATerm | null>
  search: (
    query: string,
    options?: ATermSearchOptions,
  ) => ATermSearchResult
  clearSearch: () => void
}

/**
 * Wires the ATermHandle imperative API exposed to parent components via ref.
 */
export function useATermHandle(
  ref: React.Ref<ATermHandle>,
  {
    reconnect,
    sendInput,
    status,
    atermRef,
    search,
    clearSearch,
  }: UseATermHandleOptions,
): void {
  const pasteInput = useBracketedPaste(sendInput)

  // biome-ignore lint/correctness/useExhaustiveDependencies: atermRef is a stable ref; .current is read at call time, not depended on for re-creation
  useImperativeHandle(
    ref,
    () => ({
      reconnect,
      getContent: () => getATermContent(atermRef.current),
      getLastLine: () => getATermLastLine(atermRef.current),
      sendInput,
      pasteInput,
      search,
      clearSearch,
      status,
    }),
    [clearSearch, pasteInput, reconnect, search, sendInput, status],
  )
}
