'use client'
import { Copy, GitBranch } from 'lucide-react'
import { type ChatMessage, type ChatView, chatText } from '@/lib/chat'
import { TranscriptFold } from '../TranscriptFold'
import { clock } from './chat-format'
import { MessageText } from './MessageText'

function Tools({
  message,
  messages,
}: {
  message: ChatMessage
  messages: ChatMessage[]
}) {
  const blocks = Array.isArray(message.content)
    ? (message.content as {
        type: string
        id?: string
        name?: string
        arguments?: Record<string, unknown>
      }[])
    : []
  return (
    <>
      {blocks
        .filter((b) => b.type === 'toolCall')
        .map((call, i) => {
          const result = messages.find(
            (m) =>
              m.seq > message.seq &&
              m.role === 'toolResult' &&
              m.meta.toolCallId === call.id,
          )
          const withheld =
            result?.content &&
            typeof result.content === 'object' &&
            'withheld' in result.content
          const args = call.arguments ?? {}
          const command = String(
            args.command ?? args.path ?? call.name ?? '',
          ).split('\n')[0]
          const title = `${call.name ?? 'Tool'} · ${command}`
          if (withheld)
            return (
              <p className="chat-tool chat-muted" key={call.id ?? i}>
                {title} · Output not saved: credential path
              </p>
            )
          const details = result?.meta.details as { diff?: string } | undefined
          const output = details?.diff ?? chatText(result?.content)
          return (
            <TranscriptFold
              key={call.id ?? i}
              className="chat-tool"
              summary={
                <>
                  <code>{title}</code>
                  <span>
                    {result
                      ? output.slice(0, 90).replace(/\s+/g, ' ') || 'Done'
                      : 'Running…'}
                  </span>
                </>
              }
            >
              {output || 'No output yet.'}
            </TranscriptFold>
          )
        })}
    </>
  )
}

/** What an Aico handoff says in the thread: who didn't answer and who took the turn. */
function Handoff({
  message: m,
  chat,
  handoff,
  text,
}: {
  message: ChatMessage
  chat: ChatView
  handoff: ChatView['handoffs'][number]
  text: string
}) {
  const next = chat.messages.find(
    (x) => x.role === 'assistant' && x.seq > m.seq,
  )
  return (
    <div className="chat-event">
      <p>
        {handoff.reason === 'provider_error'
          ? `${m.model} didn’t answer (provider error). ${handoff.to_model} took the same request as turn ${next?.turn ?? m.turn + 1} and goes on from here.`
          : `${m.model} declined this turn (${handoff.reason}). ${handoff.to_model} took it over with the whole chat; nothing above was lost.`}
      </p>
      <TranscriptFold summary="Show what the provider said">
        {String(m.outcome?.detail ?? m.meta.errorMessage ?? text)}
      </TranscriptFold>
    </div>
  )
}

function Message({
  message: m,
  messages,
  text,
  onBranch,
  onCopy,
}: {
  message: ChatMessage
  messages: ChatMessage[]
  text: string
  onBranch: (message: ChatMessage) => void
  onCopy: (text: string) => void
}) {
  return (
    <article
      className={`chat-message ${m.role} ${m.stop_reason === 'aborted' ? 'unfinished' : ''}`}
    >
      <div className="chat-message-head">
        <span
          className="chat-model"
          title={
            m.role === 'assistant'
              ? `Turn ${m.turn} · In ${m.input ?? '—'} · from cache ${m.cache_read ?? '—'} · written to cache ${m.cache_write ?? '—'} · out ${m.output ?? '—'}`
              : undefined
          }
        >
          {m.role === 'user' ? 'You' : m.model}
        </span>
        <span>
          {m.role === 'assistant' ? `Turn ${m.turn} · ` : ''}
          {m.stop_reason === 'aborted' ? 'unfinished' : clock(m.at)}
        </span>
        <div className="chat-actions">
          {m.role === 'assistant' && (
            <button
              className="lantern-btn ghost small"
              type="button"
              onClick={() => onBranch(m)}
            >
              <GitBranch size={14} />
              Branch from here
            </button>
          )}
          <button
            className="lantern-btn ghost small"
            type="button"
            onClick={() => onCopy(text)}
          >
            <Copy size={14} />
            Copy
          </button>
        </div>
      </div>
      <Tools message={m} messages={messages} />
      <MessageText text={text} />
    </article>
  )
}

/** The notices at the top of the thread: stale questions, a lost connection, and how the chat stopped. */
function ChatNotices({
  chat,
  disconnected,
  connectedAt,
}: {
  chat: ChatView
  disconnected: boolean
  connectedAt: number | null
}) {
  return (
    <>
      {!disconnected &&
        (chat.questionsStatus === 'stale' ||
          chat.questionsStatus === 'failed') && (
          <p className="chat-notice" role="status">
            {chat.questionsStatus === 'stale'
              ? 'Questions may be out of date.'
              : 'Questions couldn’t be loaded.'}{' '}
            Your messages are still connected.
          </p>
        )}
      {disconnected && (
        <p className="chat-notice" role="status">
          This page lost Aico. The chat may still be running. What arrived stays
          here, as of{' '}
          {connectedAt ? clock(connectedAt) : 'when the chat opened'}. Reconnect
          to catch up.
        </p>
      )}
      {chat.note && <p className="chat-event">{chat.note}</p>}
      {chat.state === 'stopped' && (
        <p className="chat-notice">
          This reply stopped at {clock(chat.updatedAt)}. What arrived is kept
          and marked unfinished. Finish the reply picks up where the chat left
          off.
        </p>
      )}
      {chat.state === 'swapped' && (
        <p className="chat-notice">
          The provider answered with{' '}
          {String(chat.outcome?.served ?? 'a different model')} instead of{' '}
          {String(chat.outcome?.requested ?? chat.model)}. The reply stopped.
          Choose a model below, then send a message or finish the reply.
        </p>
      )}
      {chat.state === 'failed' && (
        <div className="chat-notice failed" role="alert">
          <b>No model answered.</b> Your message is kept; Try again sends it to
          the role’s first choice.
          <TranscriptFold summary="Show what the provider said">
            {String(
              chat.outcome?.detail ??
                chat.outcome?.reason ??
                'No reply was received.',
            )}
          </TranscriptFold>
        </div>
      )}
    </>
  )
}

function Questions({
  chat,
  busy,
  disconnected,
  onAnswer,
}: {
  chat: ChatView
  busy: boolean
  disconnected: boolean
  onAnswer: (ask: string, option: number) => void
}) {
  return (
    <>
      {chat.questions?.map((question) => (
        <div
          className="chat-needs"
          role="group"
          aria-label="Question from this chat"
          key={question.id}
        >
          <h2>It’s waiting for your answer</h2>
          <p>{question.question}</p>
          {question.body && <p>{question.body}</p>}
          <div>
            {question.options.map((option, i) => (
              <button
                className={`lantern-btn ${i === question.recommended ? 'primary' : ''}`}
                type="button"
                disabled={busy || disconnected}
                key={option}
                onClick={() => onAnswer(question.id, i)}
              >
                {option}
                {i === question.recommended ? ' (recommended)' : ''}
              </button>
            ))}
            <span className="chat-muted">or reply below</span>
          </div>
        </div>
      ))}
    </>
  )
}

/** The thread: notices, each message, the reply being written, and the questions waiting on the owner. */
export function ChatTranscript({
  chat,
  disconnected,
  connectedAt,
  busy,
  working,
  model,
  selectedModel,
  copied,
  onBranch,
  onCopy,
  onAnswer,
}: {
  chat: ChatView
  disconnected: boolean
  connectedAt: number | null
  busy: boolean
  working: boolean
  /** The model picked in the composer ('' when none). */
  model: string
  selectedModel: string
  copied: string | null
  onBranch: (message: ChatMessage) => void
  onCopy: (text: string) => void
  onAnswer: (ask: string, option: number) => void
}) {
  return (
    <div className="chat-thread">
      <ChatNotices
        chat={chat}
        disconnected={disconnected}
        connectedAt={connectedAt}
      />
      {chat.messages
        .filter(
          (m) =>
            m.role === 'user' ||
            m.role === 'assistant' ||
            m.role === 'compaction',
        )
        .map((m) => {
          const text = chatText(m.content)
          const handoff =
            m.role === 'assistant' && m.stop_reason === 'error'
              ? chat.handoffs.find(
                  (h) => h.from_model === m.model && h.at >= m.at,
                )
              : null
          if (handoff)
            return (
              <Handoff
                key={m.seq}
                message={m}
                chat={chat}
                handoff={handoff}
                text={text}
              />
            )
          if (m.role === 'user' && text.startsWith('[handoff]')) return null
          if (m.role === 'compaction')
            return (
              <div className="chat-event" key={m.seq}>
                <p>
                  Earlier turns were summarized to fit the model’s window. You
                  can still read them here.
                </p>
                <TranscriptFold summary="Show the summary">
                  {text}
                </TranscriptFold>
              </div>
            )
          if (m.stop_reason === 'error' && !text) return null
          return (
            <Message
              key={m.seq}
              message={m}
              messages={chat.messages}
              text={text}
              onBranch={onBranch}
              onCopy={onCopy}
            />
          )
        })}
      {chat.partial && (
        <article className="chat-message assistant">
          <div className="chat-message-head">
            <span className="chat-model">{chat.partial.model}</span>
            <span>Turn {chat.partial.turn}</span>
          </div>
          <MessageText text={chat.partial.text} />
          <span className="chat-caret" aria-hidden="true" />
        </article>
      )}
      {working && (
        <p className="chat-muted" role="status">
          {chat.partial?.model || model || chat.model || selectedModel} is
          writing…
        </p>
      )}
      <Questions
        chat={chat}
        busy={busy}
        disconnected={disconnected}
        onAnswer={onAnswer}
      />
      {copied && (
        <p role="status" className="chat-muted">
          {copied}
        </p>
      )}
    </div>
  )
}
