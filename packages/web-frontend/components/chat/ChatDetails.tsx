'use client'
import { Copy, X } from 'lucide-react'
import type { ChatView } from '@/lib/chat'
import { clock, count } from './chat-format'

/** The side panel: token totals, per-model use, the run command, and End chat. */
export function ChatDetails({
  chat,
  onClose,
  onEnd,
}: {
  chat: ChatView
  onClose: () => void
  onEnd: () => void
}) {
  const tokens = chat.totals.tokens
  const perModel = new Map<
    string,
    { input: number; output: number; cache: number }
  >()
  for (const m of chat.messages)
    if (
      m.role === 'assistant' &&
      m.model &&
      (!chat.parent || m.turn > (chat.branchTurn ?? 0))
    ) {
      const sum = perModel.get(m.model) ?? { input: 0, output: 0, cache: 0 }
      sum.input += m.input ?? 0
      sum.output += m.output ?? 0
      sum.cache += m.cache_read ?? 0
      perModel.set(m.model, sum)
    }
  return (
    <aside className="chat-details" aria-label="Chat details">
      <header>
        <h2>Details</h2>
        <button
          className="lantern-icon-btn"
          type="button"
          onClick={onClose}
          aria-label="Close details"
        >
          <X size={18} />
        </button>
      </header>
      <h3>Chat totals</h3>
      <p className="chat-muted">
        Input counts new tokens. Cache counts are separate.
      </p>
      <dl>
        <dt>Started</dt>
        <dd>{clock(chat.startedAt)}</dd>
        <dt>Project folder</dt>
        <dd className="chat-folder">{chat.cwd}</dd>
        <dt>Tokens in</dt>
        <dd>{count(tokens.input)}</dd>
        <dt>From cache</dt>
        <dd>{count(tokens.cacheRead)}</dd>
        <dt>Written to cache</dt>
        <dd>{count(tokens.cacheWrite)}</dd>
        <dt>Tokens out</dt>
        <dd>{count(tokens.output)}</dd>
        <dt>Tool calls</dt>
        <dd>{count(chat.totals.toolCalls)}</dd>
        <dt>Handoffs</dt>
        <dd>{chat.handoffs.length}</dd>
        <dt>Summaries</dt>
        <dd>{chat.messages.filter((m) => m.role === 'compaction').length}</dd>
      </dl>
      <h3>Per model</h3>
      {[...perModel].map(([model, sum]) => (
        <div className="chat-model-total" key={model}>
          <code>{model}</code>
          <p>
            {count(sum.input)} in · {count(sum.cache)} from cache ·{' '}
            {count(sum.output)} out
          </p>
        </div>
      ))}
      <h3>Run</h3>
      <button
        className="lantern-btn ghost chat-run"
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(`aico agent show ${chat.id}`)
        }
      >
        <code>aico agent show {chat.id}</code>
        <Copy size={14} />
      </button>
      {chat.parent && (
        <p className="chat-muted">
          Branched from turn {chat.branchTurn} of {chat.parent}.
        </p>
      )}
      {chat.state !== 'ended' && (
        <button className="lantern-btn" type="button" onClick={onEnd}>
          End chat
        </button>
      )}
    </aside>
  )
}
