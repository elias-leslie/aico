'use client'
import { ArrowLeft, Info } from 'lucide-react'
import type { RefObject } from 'react'
import { CHAT_STATE, type ChatView } from '@/lib/chat'
import { clock } from './chat-format'

/** The chat's title bar: state, title, facts, the one action that fits the state, and the details toggle. */
export function ChatHeader({
  chat,
  disconnected,
  busy,
  working,
  inputRef,
  onBack,
  onReconnect,
  onStop,
  onResume,
  onDetails,
}: {
  chat: ChatView
  disconnected: boolean
  busy: boolean
  working: boolean
  inputRef: RefObject<HTMLTextAreaElement | null>
  onBack: () => void
  onReconnect: () => void
  onStop: () => void
  onResume: () => void
  onDetails: () => void
}) {
  return (
    <header className="chat-head">
      <button
        type="button"
        className="lantern-icon-btn chat-back"
        aria-label="Back to sessions"
        onClick={onBack}
      >
        <ArrowLeft size={20} />
      </button>
      <span className={`chat-chip ${chat.state}`}>
        {CHAT_STATE[chat.state] ?? chat.state}
      </span>
      <h1 title={chat.title}>{chat.title}</h1>
      <span className="chat-facts" title={chat.cwd}>
        {chat.role} · {chat.cwd.split('/').pop()} · since{' '}
        {clock(chat.startedAt)}
      </span>
      <span className="chat-grow" />
      {disconnected ? (
        <button
          className="lantern-btn primary chat-head-action"
          type="button"
          onClick={onReconnect}
        >
          Reconnect
        </button>
      ) : working ? (
        <button
          className="lantern-btn chat-head-action"
          type="button"
          disabled={busy}
          onClick={onStop}
        >
          Stop
        </button>
      ) : chat.state === 'needs-you' ? (
        <button
          className="lantern-btn primary chat-head-action"
          type="button"
          onClick={() => inputRef.current?.focus()}
        >
          Answer
        </button>
      ) : ['stopped', 'failed', 'swapped'].includes(chat.state) ? (
        <button
          className="lantern-btn primary chat-head-action"
          type="button"
          disabled={busy}
          onClick={onResume}
        >
          {chat.state === 'failed' ? 'Try again' : 'Finish the reply'}
        </button>
      ) : null}
      <button
        className="lantern-icon-btn chat-info"
        type="button"
        onClick={onDetails}
        aria-label="Details: tokens, models, run"
        title="Details: tokens, models, run"
      >
        <Info size={18} />
      </button>
    </header>
  )
}
