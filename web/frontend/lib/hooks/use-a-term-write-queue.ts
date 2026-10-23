'use client'

import { useCallback, useEffect, useRef } from 'react'
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
// Control-mode seeds (and a program's own reset) start with a full terminal
// reset, which throws the reader's place away.
const FULL_RESET = '\x1bc'

/** The server's way to repaint the terminal from the pane (control mode). */
export interface ATermReseedSource {
  /** Whether a repaint can be asked for now (control-mode stream). */
  available: () => boolean
  request: () => void
}

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
  reseed?: ATermReseedSource
  diagnostics?: Pick<
    UseATermDiagnosticsReturn,
    'enabled' | 'incrementCounter' | 'record'
  >
}

interface UseATermWriteQueueReturn {
  enqueueWrite: (data: string) => void
  applySnapshot: (snapshot: string, cursorPosition?: CursorPosition) => void
  resetQueue: () => void
  /** A new connection starts a new stream: clear the terminal for its seed, or
   * wait for the reader to come back when they are reading history. */
  restartStream: () => void
  /** Tell the queue the viewport moved, so a held repaint can be requested
   * as soon as the reader is back at the bottom. */
  onViewportMoved: () => void
}

function formatCursorMove(cursorPosition: CursorPosition): string {
  return `\x1b[${cursorPosition.y + 1};${cursorPosition.x + 1}H`
}

export function useATermWriteQueue({
  aTermRef,
  isVisibleRef,
  sessionMode,
  reseed,
  diagnostics,
}: UseATermWriteQueueOptions): UseATermWriteQueueReturn {
  const pendingOperationsRef = useRef<ATermOperation[]>([])
  const isDrainingRef = useRef(false)
  const resetGenerationRef = useRef(0)
  const lastSnapshotRef = useRef<string | null>(null)
  // Set while the reader is above the bottom and the stream said it was
  // starting over: the terminal keeps the history they are reading and the
  // stream is dropped. The server repaints the whole pane once they are back
  // at the bottom, so nothing is lost.
  const reseedHeldRef = useRef(false)
  const reseedRef = useRef(reseed)
  useEffect(() => {
    reseedRef.current = reseed
  }, [reseed])
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
          const isScrolledUp = buffer.viewportY < buffer.baseY
          let data = operation.data

          if (reseedHeldRef.current) {
            if (isScrolledUp) {
              resolve()
              return
            }
            reseedHeldRef.current = false
            reseedRef.current?.request()
            resolve()
            return
          }
          if (isScrolledUp && reseedRef.current?.available()) {
            const resetAt = data.indexOf(FULL_RESET)
            if (resetAt >= 0) {
              reseedHeldRef.current = true
              diagnostics?.record('reseed_held_scrolled_up', {
                chars: data.length - resetAt,
              })
              data = data.slice(0, resetAt)
              if (!data) {
                resolve()
                return
              }
            }
          }

          // xterm preserves the visible history rows itself, including when
          // scrollback trims or the reader scrolls during an async write.
          // Restoring distance from the growing bottom moves those rows.
          term.write(data, () => {
            if (!isStale()) {
              bumpCounter('writesFlushed')
              diagnostics?.record('write_flushed', {
                chars: data.length,
                scrolledUp: isScrolledUp,
              })
            }
            resolve()
          })
          return
        }

        // A shell sync replaces the buffer wholesale. Leave history in place
        // while it is being read; raw writes still update the live terminal,
        // and the next sync at bottom can repair the live view normally.
        if (term.buffer.active.viewportY < term.buffer.active.baseY) {
          diagnostics?.record('snapshot_skipped_scrolled_up', {
            chars: operation.data.length,
          })
          resolve()
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

        term.reset()
        term.write(`${operation.data}${SGR_RESET}${cursorMove}`, () => {
          if (!isStale()) {
            lastSnapshotRef.current = operation.data
            bumpCounter('snapshotApplied')
            bumpCounter('fullResetApplied')
            diagnostics?.record('snapshot_full_reset_applied', {
              chars: operation.data.length,
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
        // Keep raw writes: the reader may scroll up before this sync runs,
        // in which case skipping its reset must not lose incoming output.
        pendingOperationsRef.current = pendingOperationsRef.current.filter(
          (pending) => pending.type === 'write',
        )
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
    reseedHeldRef.current = false
  }, [])

  const restartStream = useCallback(() => {
    resetQueue()
    const term = aTermRef.current
    if (!term) return
    const buffer = term.buffer.active
    if (buffer.viewportY < buffer.baseY && reseedRef.current?.available()) {
      reseedHeldRef.current = true
      return
    }
    term.reset()
  }, [aTermRef, resetQueue])

  const onViewportMoved = useCallback(() => {
    const term = aTermRef.current
    if (!term || !reseedHeldRef.current) return
    const buffer = term.buffer.active
    if (buffer.viewportY < buffer.baseY) return
    reseedHeldRef.current = false
    reseedRef.current?.request()
  }, [aTermRef])

  return {
    enqueueWrite,
    applySnapshot,
    resetQueue,
    restartStream,
    onViewportMoved,
  }
}
