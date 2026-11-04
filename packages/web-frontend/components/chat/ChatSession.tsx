'use client'
import * as Dialog from '@radix-ui/react-dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, GitBranch, Info, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Component, type ReactNode, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import {
  CHAT_STATE,
  type ChatMessage,
  type ChatView,
  chatCall,
  chatText,
} from '@/lib/chat'
import { TranscriptFold } from '../TranscriptFold'
import './chat.css'

const clock = (value: number | string) =>
  new Date(value).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
const count = (value: number) => value.toLocaleString('en-US')
function parts(text: string, pattern: RegExp) {
  let offset = 0
  return text.split(pattern).map((part) => {
    const item = { part, offset }
    offset += part.length
    return item
  })
}
function MessageText({ text }: { text: string }) {
  return (
    <div className="chat-text">
      {parts(text, /(```[\s\S]*?```)/g).map(({ part, offset }) =>
        part.startsWith('```') ? (
          <pre key={offset}>
            <code>{part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</code>
          </pre>
        ) : (
          <span key={offset}>
            {parts(part, /(`[^`\n]+`)/g).map(({ part: chunk, offset: at }) =>
              chunk.startsWith('`') ? (
                <code key={at}>{chunk.slice(1, -1)}</code>
              ) : (
                chunk
              ),
            )}
          </span>
        ),
      )}
    </div>
  )
}

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
function ChatDetails({
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
      <dl>
        <dt>Started</dt>
        <dd>{clock(chat.startedAt)}</dd>
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
class ChatGuard extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <div role="alert" className="chat-empty">
        <h2>Couldn’t show this chat</h2>
        <p>The chat itself isn’t affected; it may still be running.</p>
        <button
          className="lantern-btn"
          type="button"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </div>
    ) : (
      this.props.children
    )
  }
}
export function ChatSession({ id }: { id: string }) {
  return (
    <ChatGuard key={id}>
      <ChatSessionBody id={id} />
    </ChatGuard>
  )
}
function ChatSessionBody({ id }: { id: string }) {
  const client = useQueryClient()
  const router = useRouter()
  const opened = useQuery({
    queryKey: ['aico-chat', id],
    queryFn: () => apiFetch<ChatView>(`/api/chat/${id}`),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const [disconnected, setDisconnected] = useState(false)
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  const [connection, setConnection] = useState(0)
  const [draft, setDraft] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [details, setDetails] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [branch, setBranch] = useState<ChatMessage | null>(null)
  const [branchDraft, setBranchDraft] = useState('')
  const [branchModel, setBranchModel] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)
  const summaryKey = useRef('')
  const savingDraft = useRef(Promise.resolve())
  const follow = useRef(true)
  const chat = opened.data
  useEffect(() => {
    if (chat && !initialized.current) {
      setDraft(chat.draft)
      initialized.current = true
    }
  }, [chat])
  const ready = Boolean(opened.data)
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection explicitly reopens the stream; token updates do not
  useEffect(() => {
    if (!ready) return
    const stream = new EventSource(`/api/chat/${id}/stream`)
    stream.onmessage = (event) => {
      try {
        const value = JSON.parse(event.data) as ChatView
        if (value.id !== id || !Array.isArray(value.messages))
          throw new Error('Invalid chat stream')
        client.setQueryData(['aico-chat', id], value)
        setDisconnected(false)
        setConnectedAt(Date.now())
        const key = `${value.state}:${value.model}:${value.messages.length}:${value.questions?.length}`
        if (summaryKey.current !== key) {
          summaryKey.current = key
          void client.invalidateQueries({ queryKey: ['terminal-sessions'] })
        }
      } catch {
        setDisconnected(true)
      }
    }
    stream.onerror = () => {
      setDisconnected(true)
      stream.close()
    }
    return () => stream.close()
    // The connection follows one opened chat, not each token.
  }, [id, ready, client, connection])
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new transcript content while the reader is at the bottom
  useEffect(() => {
    if (follow.current)
      body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [chat])
  const act = async (action: string, payload?: unknown) => {
    setBusy(true)
    setError(null)
    try {
      const value = await chatCall(`/${id}/${action}`, payload)
      if (value.id === id) client.setQueryData(['aico-chat', id], value)
      await client.invalidateQueries({ queryKey: ['terminal-sessions'] })
      return value
    } catch (e) {
      setError((e as Error).message)
      return null
    } finally {
      setBusy(false)
    }
  }
  const send = async () => {
    if (!draft.trim() || busy) return
    await savingDraft.current
    const question = chat?.questions?.[0]
    const value = question
      ? await act('answer', { ask: question.id, message: draft })
      : await act('send', {
          message: draft,
          ...(!working && model && { model }),
          ...(!working && effort && { effort }),
        })
    if (value) {
      setDraft('')
      setModel('')
      follow.current = true
    }
  }
  const stop = async () => {
    await savingDraft.current
    const value = await act('stop')
    if (value)
      setDraft((current) =>
        !current ||
        value.draft === current ||
        value.draft.startsWith(`${current}\n\n`)
          ? value.draft
          : [current, value.draft].filter(Boolean).join('\n\n'),
      )
  }
  const saveDraft = () => {
    const value = draft
    savingDraft.current = savingDraft.current
      .then(() =>
        apiFetch(`/api/chat/${id}/draft`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft: value }),
        }),
      )
      .then(() => {})
      .catch((e: Error) => setError(`Draft not saved: ${e.message}`))
  }
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('Copied.')
    } catch {
      setError('Couldn’t copy. Select the text and copy it.')
    }
  }
  if (!chat && opened.isPending)
    return (
      <div className="aico-chat chat-empty" role="status">
        <h2>Opening the chat…</h2>
        <p>Tokens: — · Tool calls: —</p>
      </div>
    )
  if (!chat)
    return (
      <div className="aico-chat chat-empty" role="alert">
        <h2>Couldn’t open this chat</h2>
        <p>
          The Aico server didn’t answer. The chat itself isn’t affected; it may
          still be running.
        </p>
        <p>{(opened.error as Error)?.message}</p>
        <button
          className="lantern-btn primary"
          type="button"
          onClick={() => void opened.refetch()}
        >
          Try again
        </button>
      </div>
    )
  const working = chat.state === 'working'
  const ended = chat.state === 'ended'
  const selectedModel =
    model ||
    (working ? chat.partial?.model || chat.model : chat.nextModel) ||
    chat.chain[0]?.id ||
    ''
  const startBranch = async () => {
    if (!branch || busy) return
    const value = await act('branch', {
      turn: branch.turn,
      message: branchDraft,
      model: branchModel,
    })
    if (value) {
      setBranch(null)
      await client.invalidateQueries({ queryKey: ['terminal-sessions'] })
      router.push(`/?session=${value.id}`)
    }
  }
  return (
    <div className="aico-chat">
      <header className="chat-head">
        <span className={`chat-chip ${chat.state}`}>
          {CHAT_STATE[chat.state] ?? chat.state}
        </span>
        <h1 title={chat.title}>{chat.title}</h1>
        <span className="chat-facts">
          {chat.role} · {chat.cwd.split('/').pop()} · since{' '}
          {clock(chat.startedAt)}
        </span>
        <span className="chat-grow" />
        {disconnected ? (
          <button
            className="lantern-btn primary"
            type="button"
            onClick={() => setConnection((v) => v + 1)}
          >
            Reconnect
          </button>
        ) : working ? (
          <button
            className="lantern-btn"
            type="button"
            disabled={busy}
            onClick={() => void stop()}
          >
            Stop
          </button>
        ) : chat.state === 'needs-you' ? (
          <button
            className="lantern-btn primary"
            type="button"
            onClick={() => input.current?.focus()}
          >
            Answer
          </button>
        ) : ['stopped', 'failed', 'swapped'].includes(chat.state) ? (
          <button
            className="lantern-btn primary"
            type="button"
            disabled={busy}
            onClick={() =>
              void act('resume', {
                ...(model && { model }),
                ...(effort && { effort }),
              })
            }
          >
            {chat.state === 'failed' ? 'Try again' : 'Finish the reply'}
          </button>
        ) : null}
        <button
          className="lantern-icon-btn"
          type="button"
          onClick={() => setDetails(!details)}
          aria-label="Details: tokens, models, run"
          title="Details: tokens, models, run"
        >
          <Info size={18} />
        </button>
      </header>
      <div className="chat-layout">
        <div className="chat-main">
          <div
            className="chat-body"
            ref={body}
            onScroll={() => {
              if (body.current)
                follow.current =
                  body.current.scrollHeight -
                    body.current.scrollTop -
                    body.current.clientHeight <
                  100
            }}
          >
            <div className="chat-thread">
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
                  This page lost Aico. The chat may still be running. What
                  arrived stays here, as of{' '}
                  {connectedAt ? clock(connectedAt) : 'when the chat opened'}.
                  Reconnect to catch up.
                </p>
              )}
              {chat.note && <p className="chat-event">{chat.note}</p>}
              {chat.state === 'stopped' && (
                <p className="chat-notice">
                  This reply stopped at {clock(chat.updatedAt)}. What arrived is
                  kept and marked unfinished. Finish the reply picks up where
                  the chat left off.
                </p>
              )}
              {chat.state === 'swapped' && (
                <p className="chat-notice">
                  The provider answered with{' '}
                  {String(chat.outcome?.served ?? 'a different model')} instead
                  of {String(chat.outcome?.requested ?? chat.model)}. The reply
                  stopped. Choose a model below, then send a message or finish
                  the reply.
                </p>
              )}
              {chat.state === 'failed' && (
                <div className="chat-notice failed" role="alert">
                  <b>No model answered.</b> Your message is kept; Try again
                  sends it to the role’s first choice.
                  <TranscriptFold summary="Show what the provider said">
                    {String(
                      chat.outcome?.detail ??
                        chat.outcome?.reason ??
                        'No reply was received.',
                    )}
                  </TranscriptFold>
                </div>
              )}
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
                  if (handoff) {
                    const next = chat.messages.find(
                      (x) => x.role === 'assistant' && x.seq > m.seq,
                    )
                    return (
                      <div key={m.seq} className="chat-event">
                        <p>
                          {handoff.reason === 'provider_error'
                            ? `${m.model} didn’t answer (provider error). ${handoff.to_model} took the same request as turn ${next?.turn ?? m.turn + 1} and goes on from here.`
                            : `${m.model} declined this turn (${handoff.reason}). ${handoff.to_model} took it over with the whole chat; nothing above was lost.`}
                        </p>
                        <TranscriptFold summary="Show what the provider said">
                          {String(
                            m.outcome?.detail ?? m.meta.errorMessage ?? text,
                          )}
                        </TranscriptFold>
                      </div>
                    )
                  }
                  if (m.role === 'user' && text.startsWith('[handoff]'))
                    return null
                  if (m.role === 'compaction')
                    return (
                      <div className="chat-event" key={m.seq}>
                        <p>
                          Earlier turns were summarized to fit the model’s
                          window. You can still read them here.
                        </p>
                        <TranscriptFold summary="Show the summary">
                          {text}
                        </TranscriptFold>
                      </div>
                    )
                  if (m.stop_reason === 'error' && !text) return null
                  return (
                    <article
                      key={m.seq}
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
                          {m.stop_reason === 'aborted'
                            ? 'unfinished'
                            : clock(m.at)}
                        </span>
                        <div className="chat-actions">
                          {m.role === 'assistant' && (
                            <button
                              className="lantern-btn ghost small"
                              type="button"
                              onClick={() => {
                                setBranch(m)
                                setBranchModel(m.model ?? selectedModel)
                                setBranchDraft('')
                              }}
                            >
                              <GitBranch size={14} />
                              Branch from here
                            </button>
                          )}
                          <button
                            className="lantern-btn ghost small"
                            type="button"
                            onClick={() => void copy(text)}
                          >
                            <Copy size={14} />
                            Copy
                          </button>
                        </div>
                      </div>
                      <Tools message={m} messages={chat.messages} />
                      <MessageText text={text} />
                    </article>
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
                  {chat.partial?.model || chat.model || selectedModel} is
                  writing…
                </p>
              )}
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
                        onClick={() =>
                          void act('answer', { ask: question.id, option: i })
                        }
                      >
                        {option}
                        {i === question.recommended ? ' (recommended)' : ''}
                      </button>
                    ))}
                    <span className="chat-muted">or reply below</span>
                  </div>
                </div>
              ))}
              {copied && (
                <p role="status" className="chat-muted">
                  {copied}
                </p>
              )}
            </div>
          </div>
          {error && (
            <p role="alert" className="chat-notice">
              {error}
            </p>
          )}
          {!ended && (
            <div className="chat-composer">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void send()
                }}
              >
                <div className="chat-compose-box">
                  <textarea
                    aria-label="Message"
                    ref={input}
                    rows={2}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={saveDraft}
                    onKeyDown={(e) => {
                      if (
                        e.key === 'Enter' &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault()
                        void send()
                      }
                    }}
                    placeholder={
                      chat.questions?.length
                        ? 'Answer, or say something else'
                        : 'Message'
                    }
                  />
                  <button
                    type="submit"
                    className="lantern-btn primary"
                    disabled={!draft.trim() || busy || disconnected}
                  >
                    {working ? 'Queue message' : 'Send'}
                  </button>
                </div>
                <div className="chat-composer-bar">
                  <label>
                    Model{' '}
                    <select
                      aria-label="Model"
                      value={selectedModel}
                      disabled={working}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      {chat.chain.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                          {m.id === chat.firstModel
                            ? ', role’s first choice'
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Effort{' '}
                    <select
                      aria-label="Effort"
                      value={effort}
                      disabled={working}
                      onChange={(e) => setEffort(e.target.value)}
                    >
                      <option value="">From routing</option>
                      {[
                        'off',
                        'minimal',
                        'low',
                        'medium',
                        'high',
                        'xhigh',
                        'max',
                      ].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <span>
                    {working
                      ? `${chat.queued.length ? `${chat.queued.length} queued · ` : ''}Sends after this reply`
                      : 'Enter to send · Shift+Enter for a new line'}
                  </span>
                </div>
              </form>
            </div>
          )}
        </div>
        {details && (
          <ChatDetails
            chat={chat}
            onClose={() => setDetails(false)}
            onEnd={() =>
              void apiFetch(`/api/sessions/${id}`, { method: 'DELETE' })
                .then(() => {
                  void opened.refetch()
                  void client.invalidateQueries({
                    queryKey: ['terminal-sessions'],
                  })
                })
                .catch((e: Error) => setError(e.message))
            }
          />
        )}
      </div>
      <Dialog.Root
        open={branch !== null}
        onOpenChange={(open) => {
          if (!open) setBranch(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="chat-scrim" />
          <Dialog.Content
            className="lantern-sheet chat-dialog"
            aria-describedby="chat-branch-description"
          >
            <header>
              <Dialog.Title>Branch from turn {branch?.turn}</Dialog.Title>
              <Dialog.Close
                className="lantern-icon-btn"
                aria-label="Close branch dialog"
              >
                <X size={18} />
              </Dialog.Close>
            </header>
            <div className="chat-fields">
              <p id="chat-branch-description">
                A new chat starts with everything up to the end of turn{' '}
                {branch?.turn} ({branch?.model}’s reply). This chat stays as it
                is.
              </p>
              <label>
                Message for the new chat
                <textarea
                  value={branchDraft}
                  rows={4}
                  onChange={(e) => setBranchDraft(e.target.value)}
                  placeholder="What should go differently?"
                />
              </label>
              <label>
                Model
                <select
                  value={branchModel}
                  onChange={(e) => setBranchModel(e.target.value)}
                >
                  {chat.chain.map((m) => (
                    <option key={m.id}>{m.id}</option>
                  ))}
                </select>
              </label>
              {error && <p role="alert">{error}</p>}
            </div>
            <footer>
              <Dialog.Close className="lantern-btn ghost">Cancel</Dialog.Close>
              <button
                className="lantern-btn primary"
                type="button"
                disabled={!branchDraft.trim() || busy}
                onClick={() => void startBranch()}
              >
                Start branch
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
