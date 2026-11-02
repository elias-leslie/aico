// The files waiting to be sent from the Capture sheet. One queue for the whole
// page, outside React, so closing the sheet (or the launcher that opened it
// leaving the screen) neither loses a draft nor stops a send.

import { useSyncExternalStore } from 'react'
import {
  type Capture,
  type CaptureLimits,
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

let snapshot: QueueSnapshot = EMPTY
let groupId = newId()
let limits: Pick<CaptureLimits, 'max_bytes' | 'max_files'> | null = null
const listeners = new Set<() => void>()

function newId(): string {
  return crypto.randomUUID()
}

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

const megabytes = (bytes: number) =>
  Math.round((bytes / (1024 * 1024)) * 10) / 10

/** The server's limits, once read: files over them are refused before sending. */
export function setCaptureLimits(
  next: Pick<CaptureLimits, 'max_bytes' | 'max_files'> | null,
) {
  limits = next
}

export function addCaptureFiles(files: readonly File[]) {
  const notes: string[] = []
  const items = [...snapshot.items]
  let tooMany = 0
  for (const file of files) {
    if (limits && items.length >= limits.max_files) {
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
  if (tooMany && limits)
    notes.push(
      `${limits.max_files} files at a time. ${tooMany} not added; send these first.`,
    )
  set({ items, notice: notes.length ? notes.join(' ') : null })
}

export function removeCaptureFile(key: string) {
  set({
    items: snapshot.items.filter((item) => item.key !== key),
    notice: null,
  })
}

export function setCaptureCaption(caption: string) {
  set({ caption })
}

/** Starts over with an empty queue, after a send or when the owner clears it. */
export function resetCaptureQueue() {
  groupId = newId()
  set({ ...EMPTY })
}

export function captureQueueLeft(items: readonly QueueItem[]): number {
  return items.filter((item) => item.state !== 'sent').length
}

async function sendOne(key: string) {
  const item = snapshot.items.find((entry) => entry.key === key)
  if (!item || item.state === 'sent') return
  patchItem(key, { state: 'sending', progress: 0, error: null })
  let capture: Capture
  try {
    capture = await uploadCapture({
      file: item.file,
      clientId: key,
      groupId,
      caption: snapshot.caption.trim() || undefined,
      onProgress: (progress) => patchItem(key, { progress }),
    })
  } catch (error) {
    patchItem(key, {
      state: 'failed',
      error: error instanceof Error ? error.message : "Couldn't send it",
    })
    return
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

/** Sends what is waiting or failed, one file at a time. */
export async function sendCaptureQueue(only?: string) {
  if (snapshot.sending) return
  set({ sending: true })
  try {
    const keys = snapshot.items
      .filter((item) =>
        only
          ? item.key === only
          : item.state === 'queued' || item.state === 'failed',
      )
      .map((item) => item.key)
    for (const key of keys) await sendOne(key)
  } finally {
    set({ sending: false })
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useCaptureQueue(): QueueSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  )
}
