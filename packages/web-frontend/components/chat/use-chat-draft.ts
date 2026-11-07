import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import type { ChatView } from '@/lib/chat'
import { useChatAttachments } from './ChatAttachments'

/**
 * The message box's text and files for one chat. Each change is written to the chat's draft on the
 * server (in order, so the last one wins), and a draft the server kept comes back on open or after
 * files failed to send. `onError` hears about a draft that did not save.
 */
export function useChatDraft(
  id: string,
  chat: ChatView | undefined,
  onError: (message: string) => void,
): {
  draft: string
  setDraft: (draft: string | ((current: string) => string)) => void
  files: ReturnType<typeof useChatAttachments>
  /** Resolves once every draft write so far has landed. */
  savingDraft: { current: Promise<void> }
  saveDraft: () => void
} {
  const client = useQueryClient()
  const [draft, setDraft] = useState('')
  const initialized = useRef(false)
  const savingDraft = useRef(Promise.resolve())
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const persistDraft = (text: string, attachments: string[]) => {
    client.setQueryData<ChatView>(['aico-chat', id], (current) =>
      current
        ? { ...current, draft: text, draftAttachments: attachments }
        : current,
    )
    savingDraft.current = savingDraft.current
      .then(() =>
        apiFetch(`/api/chat/${id}/draft`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft: text, attachments }),
        }),
      )
      .then(() => {})
      .catch((e: Error) => onError(`Draft not saved: ${e.message}`))
  }
  const files = useChatAttachments(
    id,
    chat ? (chat.draftAttachments ?? []) : undefined,
    (ids) => persistDraft(latestDraft.current, ids),
  )
  const restored = useRef('')
  useEffect(() => {
    if (
      chat?.state !== 'failed' ||
      !chat.note?.startsWith('Files weren’t sent: ') ||
      !chat.draftAttachments?.length
    )
      return
    const key = `${chat.updatedAt}:${chat.note}`
    if (restored.current === key) return
    restored.current = key
    setDraft(chat.draft)
    files.restore(chat.draftAttachments)
  }, [chat, files.restore])
  useEffect(() => {
    if (chat && !initialized.current) {
      setDraft(chat.draft)
      initialized.current = true
    }
  }, [chat])
  return {
    draft,
    setDraft,
    files,
    savingDraft,
    saveDraft: () => persistDraft(draft, files.ids),
  }
}
