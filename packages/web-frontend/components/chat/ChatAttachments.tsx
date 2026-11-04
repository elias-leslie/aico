'use client'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { captureFileUrl, fetchCapture, uploadCapture } from '@/lib/api/captures'
import { useCaptureLimits } from '@/lib/hooks/use-captures'
import { CapturePicker } from '../capture/CapturePicker'

interface Attachment {
  key: string
  name: string
  id?: string
  file?: File
  progress: number
  state: 'sending' | 'ready' | 'failed'
  error?: string
}

interface AttachmentQueue {
  items: Attachment[]
  initialized: boolean
  listeners: Set<() => void>
  controllers: Map<string, AbortController>
  save: (ids: string[]) => void
}
const queues = new Map<string, AttachmentQueue>()
const emptyItems: Attachment[] = []

export function useChatAttachments(
  chatId: string,
  initial: string[] | undefined,
  save: (ids: string[]) => void,
) {
  let queue = queues.get(chatId)
  if (!queue) {
    queue = {
      items: [],
      initialized: false,
      listeners: new Set(),
      controllers: new Map(),
      save,
    }
    queues.set(chatId, queue)
  }
  const state = queue
  const items = useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
    () => state.items,
    () => emptyItems,
  )
  const current = {
    get current() {
      return state.items
    },
    set current(items: Attachment[]) {
      state.items = items
    },
  }
  state.save = save
  const controllers = { current: state.controllers }
  const change = (
    update: (items: Attachment[]) => Attachment[],
    persist = true,
  ) => {
    const next = update(current.current)
    current.current = next
    for (const listener of state.listeners) listener()
    if (persist) state.save(next.flatMap((item) => (item.id ? [item.id] : [])))
  }
  const restore = (ids: string[]) => {
    for (const id of ids) {
      if (current.current.some((item) => item.id === id)) continue
      change(
        (items) => [
          ...items,
          { key: id, id, name: 'Attached file', state: 'ready', progress: 100 },
        ],
        false,
      )
      void fetchCapture(id)
        .then((capture) =>
          change(
            (items) =>
              items.map((item) =>
                item.id === id ? { ...item, name: capture.name } : item,
              ),
            false,
          ),
        )
        .catch((error: Error) =>
          change(
            (items) =>
              items.map((item) =>
                item.id === id
                  ? { ...item, state: 'failed', error: error.message }
                  : item,
              ),
            false,
          ),
        )
    }
  }
  // Initial refs arrive with the chat; later stream updates must not replace the draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialize exactly once when the chat opens
  useEffect(() => {
    if (initial === undefined || state.initialized) return
    state.initialized = true
    restore(initial)
  }, [initial])
  const upload = async (item: Attachment) => {
    if (!item.file) return
    const controller = new AbortController()
    controllers.current.set(item.key, controller)
    change(
      (items) =>
        items.map((row) =>
          row.key === item.key
            ? { ...row, state: 'sending', error: undefined, progress: 0 }
            : row,
        ),
      false,
    )
    try {
      const capture = await uploadCapture({
        file: item.file,
        clientId: item.key,
        groupId: `chat-${chatId}-${item.key}`,
        signal: controller.signal,
        onProgress: (progress) =>
          change(
            (items) =>
              items.map((row) =>
                row.key === item.key ? { ...row, progress } : row,
              ),
            false,
          ),
      })
      change((items) =>
        items.map((row) =>
          row.key === item.key
            ? {
                ...row,
                file: undefined,
                id: capture.id,
                state: 'ready',
                progress: 100,
              }
            : row,
        ),
      )
    } catch (error) {
      if (!controller.signal.aborted)
        change(
          (items) =>
            items.map((row) =>
              row.key === item.key
                ? { ...row, state: 'failed', error: (error as Error).message }
                : row,
            ),
          false,
        )
    } finally {
      controllers.current.delete(item.key)
    }
  }
  return {
    items,
    ids: items.flatMap((item) => (item.id ? [item.id] : [])),
    blocked: items.some((item) => item.state !== 'ready'),
    uploading: items.some((item) => item.state === 'sending'),
    restore,
    clear: () => change(() => [], false),
    remove: (key: string) => {
      controllers.current.get(key)?.abort()
      change((items) => items.filter((item) => item.key !== key))
    },
    add: (files: File[]) => {
      const added: Attachment[] = files.map((file) => ({
        key: crypto.randomUUID(),
        name: file.name,
        file,
        state: 'sending',
        progress: 0,
      }))
      change((items) => [...items, ...added], false)
      for (const item of added) void upload(item)
    },
    retry: (item: Attachment) => void upload(item),
  }
}

export function ChatAttachmentRows({
  queue,
}: {
  queue: ReturnType<typeof useChatAttachments>
}) {
  if (!queue.items.length) return null
  return (
    <ul className="chat-attachments" aria-label="Attachments">
      {queue.items.map((item) => (
        <li key={item.key}>
          <div>
            <span className="chat-attachment-name">
              {item.id && item.state === 'ready' ? (
                <a
                  href={captureFileUrl(item.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {item.name}
                </a>
              ) : (
                item.name
              )}
            </span>
            <span
              className="chat-muted"
              role={item.state === 'failed' ? 'alert' : 'status'}
            >
              {item.state === 'ready'
                ? 'Ready'
                : item.state === 'failed'
                  ? item.error
                  : item.progress >= 100
                    ? 'Saving…'
                    : `Sending ${item.progress}%`}
            </span>
            {item.state === 'sending' && (
              <progress
                aria-label={`Uploading ${item.name}`}
                max={100}
                value={item.progress}
              />
            )}
          </div>
          {item.state === 'failed' && item.file && (
            <button
              className="lantern-btn small"
              type="button"
              onClick={() => queue.retry(item)}
            >
              Retry
            </button>
          )}
          <button
            className="lantern-icon-btn"
            type="button"
            aria-label={`Remove ${item.name}`}
            onClick={() => queue.remove(item.key)}
          >
            <X size={16} />
          </button>
        </li>
      ))}
    </ul>
  )
}

export function ChatAttachmentSheet({
  open,
  onOpenChange,
  onFiles,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onFiles: (files: File[]) => void
}) {
  const { limits } = useCaptureLimits()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="chat-scrim" />
        <Dialog.Content
          className="lantern-sheet chat-dialog chat-attach-sheet"
          aria-describedby="chat-attach-description"
        >
          <header>
            <Dialog.Title>Add to this message</Dialog.Title>
            <Dialog.Close
              className="lantern-icon-btn"
              aria-label="Close attachments"
            >
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className="chat-fields">
            <CapturePicker
              accept={limits?.accept}
              paste={false}
              onFiles={(files) => {
                onFiles(files)
                onOpenChange(false)
              }}
            />
            <p id="chat-attach-description">
              They upload while you type and go with your next message. Photos
              go as images and text files as text.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
