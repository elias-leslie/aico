'use client'
import { Plus, Send, Square } from 'lucide-react'
import type { RefObject } from 'react'
import type { ChatView } from '@/lib/chat'
import { ChatAttachmentRows, type useChatAttachments } from './ChatAttachments'

const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The message box with Send (Queue message while the chat is writing), Stop, the model and the effort. */
export function ChatComposer({
  chat,
  draft,
  files,
  busy,
  disconnected,
  working,
  selectedModel,
  effort,
  inputRef,
  onDraft,
  onModel,
  onEffort,
  onSend,
  onStop,
  onAttach,
  onFocus,
  onBlur,
}: {
  chat: ChatView
  draft: string
  files: ReturnType<typeof useChatAttachments>
  busy: boolean
  disconnected: boolean
  working: boolean
  selectedModel: string
  effort: string | null
  inputRef: RefObject<HTMLTextAreaElement | null>
  onDraft: (draft: string) => void
  onModel: (model: string) => void
  onEffort: (effort: string) => void
  onSend: () => void
  onStop: () => void
  onAttach: () => void
  onFocus: () => void
  onBlur: () => void
}) {
  return (
    <div className="chat-composer">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSend()
        }}
      >
        <ChatAttachmentRows queue={files} />
        <div className="chat-compose-box">
          <button
            type="button"
            className="lantern-icon-btn chat-add"
            aria-label="Add photos or files"
            disabled={busy || disconnected || Boolean(chat.questions?.length)}
            onClick={() => {
              inputRef.current?.blur()
              onAttach()
            }}
          >
            <Plus size={20} />
          </button>
          <textarea
            aria-label="Message"
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault()
                onSend()
              }
            }}
            placeholder={chat.questions?.length ? 'Answer' : 'Message'}
          />
          <button
            type="submit"
            className="lantern-btn primary chat-send"
            aria-label={working ? 'Queue message' : 'Send'}
            disabled={!draft.trim() || busy || disconnected || files.blocked}
          >
            <Send className="chat-send-icon" size={18} />
            <span>{working ? 'Queue message' : 'Send'}</span>
          </button>
          {working && (
            <button
              type="button"
              className="lantern-icon-btn chat-compose-stop"
              onPointerDown={(event) => event.preventDefault()}
              aria-label="Stop this reply"
              disabled={busy}
              onClick={() => onStop()}
            >
              <Square size={16} />
            </button>
          )}
        </div>
        <div className="chat-composer-bar">
          <label>
            Model{' '}
            <select
              aria-label="Model"
              value={selectedModel}
              disabled={working}
              onChange={(e) => onModel(e.target.value)}
            >
              {chat.chain.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.id === chat.firstModel ? ', role’s first choice' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Effort{' '}
            <select
              aria-label="Effort"
              value={effort ?? chat.effort ?? ''}
              disabled={working}
              onChange={(e) => onEffort(e.target.value)}
            >
              <option value="">From routing</option>
              {EFFORTS.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <span>
            {files.blocked ? (
              files.uploading ? (
                'Sends when the upload is done'
              ) : (
                'Retry or remove the file'
              )
            ) : working ? (
              `${chat.queued.length ? `${chat.queued.length} queued · ` : ''}Sends after this reply`
            ) : (
              <>
                <span className="chat-desktop-hint">
                  Enter to send · Shift+Enter for a new line
                </span>
                <span className="chat-phone-hint">Next turn</span>
              </>
            )}
          </span>
        </div>
      </form>
    </div>
  )
}
