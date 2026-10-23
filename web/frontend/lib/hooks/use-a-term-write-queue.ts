'use client'

import { useCallback, useEffect, useRef } from 'react'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>
const MAX_COALESCE_CHARS = 16_384
// Control-mode seeds (and a program's own reset) start with a full terminal
// reset, which throws the reader's place away.
const FULL_RESET = '\x1bc'

/** The server's way to repaint the terminal from the pane (control mode). */
export interface ATermReseedSource {
  /** Whether a repaint can be asked for now (control-mode stream). */
  available: () => boolean
  request: () => void
}

interface UseATermWriteQueueOptions {
  aTermRef: React.RefObject<XtermATerm | null>
  isVisibleRef: React.RefObject<boolean>
  reseed?: ATermReseedSource
}

interface UseATermWriteQueueReturn {
  enqueueWrite: (data: string) => void
  resetQueue: () => void
  /** A new connection starts a new stream: clear the terminal for its seed, or
   * wait for the reader to come back when they are reading history. */
  restartStream: () => void
  /** Tell the queue the viewport moved, so a held repaint can be requested
   * as soon as the reader is back at the bottom. */
  onViewportMoved: () => void
}

export function useATermWriteQueue({
  aTermRef,
  isVisibleRef,
  reseed,
}: UseATermWriteQueueOptions): UseATermWriteQueueReturn {
  const pendingWritesRef = useRef<string[]>([])
  const isDrainingRef = useRef(false)
  const resetGenerationRef = useRef(0)
  // Set while the reader is above the bottom and the stream said it was
  // starting over: the terminal keeps the history they are reading and the
  // stream is dropped. The server repaints the whole pane once they are back
  // at the bottom, so nothing is lost.
  const reseedHeldRef = useRef(false)
  const reseedRef = useRef(reseed)
  useEffect(() => {
    reseedRef.current = reseed
  }, [reseed])

  const runWrite = useCallback(
    (data: string, generation: number) =>
      new Promise<void>((resolve) => {
        const term = aTermRef.current
        const isStale = () => generation !== resetGenerationRef.current

        if (!term || !isVisibleRef.current || isStale()) {
          resolve()
          return
        }

        const buffer = term.buffer.active
        const isScrolledUp = buffer.viewportY < buffer.baseY

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
        term.write(data, () => resolve())
      }),
    [isVisibleRef, aTermRef],
  )

  const drainQueue = useCallback(async () => {
    const generation = resetGenerationRef.current

    try {
      while (generation === resetGenerationRef.current) {
        let data = pendingWritesRef.current.shift()
        if (data === undefined) {
          return
        }

        // Merge all consecutive writes so xterm.js renders one atomic
        // frame instead of partial redraws that leave ghost text.
        while (pendingWritesRef.current.length > 0) {
          data += pendingWritesRef.current.shift()
        }

        await runWrite(data, generation)
      }
    } finally {
      isDrainingRef.current = false
      if (pendingWritesRef.current.length > 0) {
        isDrainingRef.current = true
        void drainQueue()
      }
    }
  }, [runWrite])

  const scheduleDrain = useCallback(() => {
    if (isDrainingRef.current) return
    isDrainingRef.current = true
    void drainQueue()
  }, [drainQueue])

  const enqueueWrite = useCallback(
    (data: string) => {
      // Never split a single message — arbitrary byte-boundary splits
      // bisect escape sequences and cause ghost-text corruption.
      // Drain-time coalescing merges queued writes before rendering.
      const last = pendingWritesRef.current.length - 1
      if (
        last >= 0 &&
        pendingWritesRef.current[last].length + data.length <=
          MAX_COALESCE_CHARS
      ) {
        pendingWritesRef.current[last] += data
      } else {
        pendingWritesRef.current.push(data)
      }
      scheduleDrain()
    },
    [scheduleDrain],
  )

  const resetQueue = useCallback(() => {
    resetGenerationRef.current += 1
    pendingWritesRef.current.length = 0
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
    resetQueue,
    restartStream,
    onViewportMoved,
  }
}
