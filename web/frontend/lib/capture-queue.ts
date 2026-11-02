// The files waiting to be sent. The Capture sheet has one queue for the whole
// page, outside React, so closing the sheet (or the launcher that opened it
// leaving the screen) neither loses a draft nor stops a send. A Needs-you card
// that asks for files has its own queue per ask (`askCaptureQueue`), tagged
// with the ask id, so a card folding or the drawer closing loses nothing.

import { useSyncExternalStore } from 'react'
import {
  type Capture,
  type CaptureLimits,
  deleteCapture,
  uploadCapture,
  uploadThumb,
} from './api/captures'
import { makeThumbnail } from './capture-thumb'

export type ItemState = 'queued' | 'sending' | 'sent' | 'failed'

export interface QueueItem {
  /** Also the `client_id` sent with the file: a retry never saves it twice. */
  key: string
  file: File
  state: ItemState
  progress: number
  error: string | null
  capture: Capture | null
}

export interface QueueSnapshot {
  items: QueueItem[]
  caption: string
  /** Files turned away when they were added (too many, too big). */
  notice: string | null
  sending: boolean
}

const EMPTY: QueueSnapshot = {
  items: [],
  caption: '',
  notice: null,
  sending: false,
}

type Limits = Pick<CaptureLimits, 'max_bytes' | 'max_files'>

/** The server's limits, once read: files over them are refused before sending. */
let limits: Limits | null = null
export function setCaptureLimits(next: Limits | null) {
  limits = next
}

const newId = () => crypto.randomUUID()

const megabytes = (bytes: number) =>
  Math.round((bytes / (1024 * 1024)) * 10) / 10

export interface CaptureQueue {
  getSnapshot(): QueueSnapshot
  subscribe(listener: () => void): () => void
  /** `room`: the most files this queue holds at once (an ask's maximum); unset: the server's batch limit. */
  add(files: readonly File[], room?: number): void
  /** Takes a waiting or failed file out; a saved one is deleted on the server first. */
  remove(key: string): Promise<void>
  /** Stops a file that is waiting or on its way, and forgets it. */
  cancel(key: string): void
  setCaption(caption: string): void
  reset(): void
  /** Sends what is waiting or failed, one file at a time; `only`: that one file. */
  send(only?: string): Promise<void>
  /** Puts a failed file back in line and sends. */
  retry(key: string): Promise<void>
}

function createQueue(options: { askId?: string } = {}): CaptureQueue {
  let snapshot: QueueSnapshot = EMPTY
  let groupId = newId()
  const listeners = new Set<() => void>()
  const aborts = new Map<string, AbortController>()
  const cancelled = new Set<string>()

  function set(next: Partial<QueueSnapshot>) {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }

  function patchItem(key: string, change: Partial<QueueItem>) {
    set({
      items: snapshot.items.map((item) =>
        item.key === key ? { ...item, ...change } : item,
      ),
    })
  }

  const dropItem = (key: string) =>
    set({ items: snapshot.items.filter((item) => item.key !== key) })

  async function sendOne(key: string) {
    const item = snapshot.items.find((entry) => entry.key === key)
    if (!item || item.state === 'sent') return
    const abort = new AbortController()
    aborts.set(key, abort)
    patchItem(key, { state: 'sending', progress: 0, error: null })
    let capture: Capture
    try {
      capture = await uploadCapture({
        file: item.file,
        clientId: key,
        // An ask's files are counted against the ask, not a batch.
        groupId: options.askId ? undefined : groupId,
        askId: options.askId,
        caption: snapshot.caption.trim() || undefined,
        onProgress: (progress) => patchItem(key, { progress }),
        signal: abort.signal,
      })
    } catch (error) {
      aborts.delete(key)
      if (cancelled.delete(key)) return dropItem(key)
      patchItem(key, {
        state: 'failed',
        error: error instanceof Error ? error.message : "Couldn't send it",
      })
      return
    }
    aborts.delete(key)
    if (cancelled.delete(key)) {
      // It landed as the owner cancelled: it must not stay tagged to the ask.
      void deleteCapture(capture.id).catch(() => undefined)
      return dropItem(key)
    }
    patchItem(key, { state: 'sent', progress: 100, capture })
    // The capture is saved; a missing thumbnail only means an icon in the list.
    if (
      item.file.type.startsWith('image/') ||
      /\.(heic|heif)$/i.test(item.file.name)
    ) {
      try {
        const jpeg = await makeThumbnail(item.file)
        if (jpeg) await uploadThumb(capture.id, jpeg)
      } catch {
        // Left without a thumbnail.
      }
    }
  }

  async function send(only?: string) {
    if (snapshot.sending) return
    set({ sending: true })
    try {
      if (only) {
        await sendOne(only)
        return
      }
      // Files added while this runs are picked up by the next pass.
      // An ask's failed files wait for Retry; the sheet's Send tries them again.
      const tried = new Set<string>()
      for (;;) {
        const next = snapshot.items.find(
          (item) =>
            (item.state === 'queued' ||
              (item.state === 'failed' && !options.askId)) &&
            !tried.has(item.key),
        )
        if (!next) break
        tried.add(next.key)
        await sendOne(next.key)
      }
    } finally {
      set({ sending: false })
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    add(files, room) {
      const items = [...snapshot.items]
      let tooMany = 0
      const held = () =>
        options.askId
          ? items.filter((item) => item.state !== 'failed').length
          : items.length
      for (const file of files) {
        const capacity = room ?? limits?.max_files
        const full = capacity !== undefined && held() >= capacity
        if (full) {
          tooMany += 1
          continue
        }
        const tooBig = limits !== null && file.size > limits.max_bytes
        items.push({
          key: newId(),
          file,
          state: tooBig ? 'failed' : 'queued',
          progress: 0,
          error: tooBig
            ? `That file is over ${megabytes(limits?.max_bytes ?? 0)} MB`
            : null,
          capture: null,
        })
      }
      let notice: string | null = null
      if (tooMany && room !== undefined)
        notice = `That is all this question takes. ${tooMany} not added.`
      else if (tooMany && limits)
        notice = `${limits.max_files} files at a time. ${tooMany} not added; send these first.`
      set({ items, notice })
    },
    async remove(key) {
      const item = snapshot.items.find((entry) => entry.key === key)
      if (!item) return
      if (item.state === 'sent' && item.capture) {
        try {
          await deleteCapture(item.capture.id)
        } catch {
          set({ notice: "Couldn't remove it. Try again." })
          return
        }
      } else if (item.state === 'sending') return
      set({
        items: snapshot.items.filter((entry) => entry.key !== key),
        notice: null,
      })
    },
    cancel(key) {
      const item = snapshot.items.find((entry) => entry.key === key)
      if (!item) return
      const abort = aborts.get(key)
      if (item.state === 'sending' && abort) {
        cancelled.add(key)
        abort.abort()
        return
      }
      if (item.state === 'queued') dropItem(key)
    },
    setCaption: (caption) => set({ caption }),
    reset() {
      groupId = newId()
      set({ ...EMPTY })
    },
    send,
    async retry(key) {
      patchItem(key, { state: 'queued', error: null })
      await send()
    },
  }
}

/** The Capture sheet's queue. */
const sheetQueue = createQueue()

export const addCaptureFiles = (files: readonly File[]) => sheetQueue.add(files)

export function removeCaptureFile(key: string) {
  const item = sheetQueue.getSnapshot().items.find((entry) => entry.key === key)
  if (item && (item.state === 'queued' || item.state === 'failed'))
    void sheetQueue.remove(key)
}

export const setCaptureCaption = (caption: string) =>
  sheetQueue.setCaption(caption)

/** Starts over with an empty queue, after a send or when the owner clears it. */
export const resetCaptureQueue = () => sheetQueue.reset()

export function captureQueueLeft(items: readonly QueueItem[]): number {
  return items.filter((item) => item.state !== 'sent').length
}

/** Sends what is waiting or failed, one file at a time. */
export const sendCaptureQueue = (only?: string) => sheetQueue.send(only)

export function useQueue(queue: CaptureQueue): QueueSnapshot {
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot, () => EMPTY)
}

export const useCaptureQueue = () => useQueue(sheetQueue)

/** A queue nothing sends to, for a card that asks for no files (hooks cannot be skipped). */
export const idleCaptureQueue = createQueue()

const askQueues = new Map<string, CaptureQueue>()

/** The queue for one ask's files, made on first use and kept until the answer
 * is sent, so the card can fold, unmount and come back with its files. */
export function askCaptureQueue(askId: string): CaptureQueue {
  let queue = askQueues.get(askId)
  if (!queue) {
    queue = createQueue({ askId })
    askQueues.set(askId, queue)
  }
  return queue
}

export function dropAskCaptureQueue(askId: string) {
  askQueues.delete(askId)
}
