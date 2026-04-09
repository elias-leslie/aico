'use client'

import { useCallback, useRef } from 'react'
import { isTuiSessionMode } from '../utils/session-mode'
import type {
  DiagnosticCounters,
  UseATermDiagnosticsReturn,
} from './use-a-term-diagnostics'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>
type CursorPosition = { x: number; y: number }
type ATermOperation =
  | { type: 'write'; data: string }
  | { type: 'snapshot'; data: string; cursorPosition?: CursorPosition }
const MAX_COALESCE_CHARS = 16_384
const SGR_RESET = '\x1b[0m'

function splitSnapshotLines(snapshot: string): string[] {
  const lines = snapshot.split(/\r?\n/)
  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop()
  }
  return lines
}

interface UseATermWriteQueueOptions {
  aTermRef: React.RefObject<XtermATerm | null>
  isVisibleRef: React.RefObject<boolean>
  sessionMode?: string
  diagnostics?: Pick<
    UseATermDiagnosticsReturn,
    'enabled' | 'incrementCounter' | 'record'
  >
}

interface UseATermWriteQueueReturn {
  enqueueWrite: (data: string) => void
  applySnapshot: (snapshot: string, cursorPosition?: CursorPosition) => void
  resetQueue: () => void
}

function formatCursorMove(cursorPosition: CursorPosition): string {
  return `\x1b[${cursorPosition.y + 1};${cursorPosition.x + 1}H`
}

export function useATermWriteQueue({
  aTermRef,
  isVisibleRef,
  sessionMode,
  diagnostics,
}: UseATermWriteQueueOptions): UseATermWriteQueueReturn {
  const pendingOperationsRef = useRef<ATermOperation[]>([])
  const isDrainingRef = useRef(false)
  const resetGenerationRef = useRef(0)
  const lastSnapshotRef = useRef<string | null>(null)
  const isTuiSession = isTuiSessionMode(sessionMode)

  const getSnapshotLastLine = useCallback((snapshot: string) => {
    return splitSnapshotLines(snapshot).at(-1) ?? ''
  }, [])

  const hasPendingPromptInput = useCallback(
    (term: XtermATerm, snapshot: string) => {
      const buffer = term.buffer.active
      if (buffer.viewportY < buffer.baseY) return false

      const cursorLine = buffer.getLine(buffer.baseY + buffer.cursorY)
      const currentLine = cursorLine?.translateToString(true) ?? ''
      const snapshotLastLine = getSnapshotLastLine(snapshot)

      return (
        currentLine.length > snapshotLastLine.length &&
        currentLine.startsWith(snapshotLastLine)
      )
    },
    [getSnapshotLastLine],
  )

  const bumpCounter = useCallback(
    (counter: keyof DiagnosticCounters, delta = 1) => {
      diagnostics?.incrementCounter(counter, delta)
    },
    [diagnostics],
  )

  const runOperation = useCallback(
    (operation: ATermOperation, generation: number) =>
      new Promise<void>((resolve) => {
        const term = aTermRef.current
        const isStale = () => generation !== resetGenerationRef.current

        if (!term || !isVisibleRef.current || isStale()) {
          resolve()
          return
        }

        if (operation.type === 'write') {
          const buffer = term.buffer.active
          const savedViewportY = buffer.viewportY
          const savedLinesFromBottom = buffer.baseY - savedViewportY
          const isScrolledUp = buffer.viewportY < buffer.baseY

          term.write(operation.data, () => {
            const nextTerm = aTermRef.current
            const nextBuffer = nextTerm?.buffer.active

            if (!isStale() && isScrolledUp && nextTerm && nextBuffer) {
              const targetLine = Math.max(
                nextBuffer.baseY - savedLinesFromBottom,
                0,
              )
              if (nextBuffer.viewportY !== targetLine) {
                nextTerm.scrollToLine(targetLine)
              }
            }
            if (!isStale()) {
              bumpCounter('writesFlushed')
              diagnostics?.record('write_flushed', {
                chars: operation.data.length,
                scrolledUp: isScrolledUp,
              })
            }
            resolve()
          })
          return
        }

        if (hasPendingPromptInput(term, operation.data)) {
          bumpCounter('snapshotSkippedPromptInput')
          diagnostics?.record('snapshot_skipped_prompt_input', {
            chars: operation.data.length,
          })
          resolve()
          return
        }

        const previousSnapshot = lastSnapshotRef.current
        const cursorMove = operation.cursorPosition
          ? formatCursorMove(operation.cursorPosition)
          : ''
        const buffer = term.buffer.active

        // Fast path: snapshot is byte-identical — skip entirely.
        if (previousSnapshot === operation.data) {
          const finish = () => {
            lastSnapshotRef.current = operation.data
            bumpCounter('snapshotSkippedIdentical')
            diagnostics?.record('snapshot_skipped_identical', {
              chars: operation.data.length,
            })
            resolve()
          }
          if (cursorMove) {
            term.write(cursorMove, finish)
            return
          }
          finish()
          return
        }

        const linesFromBottom = buffer.baseY - buffer.viewportY
        term.reset()
        term.write(`${operation.data}${SGR_RESET}${cursorMove}`, () => {
          if (!isStale() && aTermRef.current && linesFromBottom > 0) {
            const nextBuffer = aTermRef.current.buffer.active
            aTermRef.current.scrollToLine(
              Math.max(nextBuffer.baseY - linesFromBottom, 0),
            )
          }
          if (!isStale()) {
            lastSnapshotRef.current = operation.data
            bumpCounter('snapshotApplied')
            bumpCounter('fullResetApplied')
            diagnostics?.record('snapshot_full_reset_applied', {
              chars: operation.data.length,
              linesFromBottom,
            })
          }
          resolve()
        })
      }),
    [bumpCounter, diagnostics, hasPendingPromptInput, isVisibleRef, aTermRef],
  )

  const drainQueue = useCallback(async () => {
    const generation = resetGenerationRef.current

    try {
      while (generation === resetGenerationRef.current) {
        const operation = pendingOperationsRef.current.shift()
        if (!operation) {
          return
        }

        // Merge all consecutive writes so xterm.js renders one atomic
        // frame instead of partial redraws that leave ghost text.
        if (operation.type === 'write') {
          while (pendingOperationsRef.current[0]?.type === 'write') {
            operation.data += pendingOperationsRef.current.shift()!.data
          }
        }

        await runOperation(operation, generation)
      }
    } finally {
      isDrainingRef.current = false
      if (pendingOperationsRef.current.length > 0) {
        isDrainingRef.current = true
        void drainQueue()
      }
    }
  }, [runOperation])

  const scheduleDrain = useCallback(() => {
    if (isDrainingRef.current) return
    isDrainingRef.current = true
    void drainQueue()
  }, [drainQueue])

  const enqueueOperation = useCallback(
    (operation: ATermOperation) => {
      if (operation.type === 'snapshot') {
        pendingOperationsRef.current.length = 0
        pendingOperationsRef.current.push(operation)
      } else {
        const lastOperation = pendingOperationsRef.current.at(-1)
        if (
          lastOperation?.type === 'write' &&
          lastOperation.data.length + operation.data.length <=
            MAX_COALESCE_CHARS
        ) {
          lastOperation.data += operation.data
        } else {
          pendingOperationsRef.current.push(operation)
        }
      }

      scheduleDrain()
    },
    [scheduleDrain],
  )

  const enqueueWrite = useCallback(
    (data: string) => {
      // Never split a single message — arbitrary byte-boundary splits
      // bisect escape sequences and cause ghost-text corruption.
      // Drain-time coalescing merges queued writes before rendering.
      bumpCounter('writesEnqueued')
      enqueueOperation({ type: 'write', data })
    },
    [bumpCounter, enqueueOperation],
  )

  const applySnapshot = useCallback(
    (snapshot: string, cursorPosition?: CursorPosition) => {
      if (isTuiSession) {
        diagnostics?.record('snapshot_skipped_tui_session', {
          chars: snapshot.length,
          hasCursorPosition: !!cursorPosition,
        })
        return
      }
      enqueueOperation({ type: 'snapshot', data: snapshot, cursorPosition })
    },
    [diagnostics, enqueueOperation, isTuiSession],
  )

  const resetQueue = useCallback(() => {
    resetGenerationRef.current += 1
    pendingOperationsRef.current.length = 0
    lastSnapshotRef.current = null
  }, [])

  return { enqueueWrite, applySnapshot, resetQueue }
}
