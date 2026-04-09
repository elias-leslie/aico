'use client'

import { useImperativeHandle } from 'react'
import type {
  ATermHandle,
  ATermSearchOptions,
  ATermSearchResult,
  ConnectionStatus,
} from '../../components/a-term.types'
import { getATermContent, getATermLastLine } from '../utils/a-term-buffer'
import { useBracketedPaste } from './use-bracketed-paste'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

interface UseATermHandleOptions {
  reconnect: () => void
  sendInput: (data: string) => void
  status: ConnectionStatus
  aTermRef: React.RefObject<XtermATerm | null>
  search: (query: string, options?: ATermSearchOptions) => ATermSearchResult
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
    aTermRef,
    search,
    clearSearch,
  }: UseATermHandleOptions,
): void {
  const pasteInput = useBracketedPaste(sendInput)

  // biome-ignore lint/correctness/useExhaustiveDependencies: aTermRef is a stable ref; .current is read at call time, not depended on for re-creation
  useImperativeHandle(
    ref,
    () => ({
      reconnect,
      getContent: () => getATermContent(aTermRef.current),
      getLastLine: () => getATermLastLine(aTermRef.current),
      sendInput,
      pasteInput,
      search,
      clearSearch,
      status,
    }),
    [clearSearch, pasteInput, reconnect, search, sendInput, status],
  )
}
