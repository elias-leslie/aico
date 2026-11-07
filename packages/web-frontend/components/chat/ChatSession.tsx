'use client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { Component, type ReactNode, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { type ChatMessage, type ChatView, chatCall } from '@/lib/chat'
import { ChatAttachmentSheet } from './ChatAttachments'
import { ChatBranchDialog } from './ChatBranchDialog'
import { ChatComposer } from './ChatComposer'
import { ChatDetails } from './ChatDetails'
import { ChatHeader } from './ChatHeader'
import { ChatTranscript } from './ChatTranscript'
import { useChatDraft } from './use-chat-draft'
import { useChatScroll } from './use-chat-scroll'
import { useChatStream } from './use-chat-stream'
import './chat.css'

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
export function ChatSession({
  id,
  onBack,
}: {
  id: string
  onBack?: () => void
}) {
  return (
    <ChatGuard key={id}>
      <ChatSessionBody id={id} onBack={onBack} />
    </ChatGuard>
  )
}
function ChatSessionBody({ id, onBack }: { id: string; onBack?: () => void }) {
  const client = useQueryClient()
  const router = useRouter()
  const opened = useQuery({
    queryKey: ['aico-chat', id],
    queryFn: () => apiFetch<ChatView>(`/api/chat/${id}`),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<string | null>(null)
  const [details, setDetails] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [typing, setTyping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [branch, setBranch] = useState<ChatMessage | null>(null)
  const [branchDraft, setBranchDraft] = useState('')
  const [branchModel, setBranchModel] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const chat = opened.data
  const { disconnected, connectedAt, reconnect } = useChatStream(
    id,
    Boolean(opened.data),
  )
  const scroll = useChatScroll(chat)
  const { draft, setDraft, files, savingDraft, saveDraft } = useChatDraft(
    id,
    chat,
    setError,
  )
  useEffect(() => {
    if (chat?.state && chat.state !== 'working') setModel('')
  }, [chat?.state])
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
    if (!draft.trim() || busy || files.blocked) return
    await savingDraft.current
    const question = chat?.questions?.[0]
    const value = question
      ? await act('answer', {
          ask: question.id,
          message: draft,
          ...(files.ids.length && { attachments: files.ids }),
        })
      : await act('send', {
          message: draft,
          ...(files.ids.length && { attachments: files.ids }),
          ...(!working && model && { model }),
          ...(!working && effort !== null && { effort: effort || null }),
        })
    if (value) {
      setDraft('')
      files.clear()
      scroll.follow.current = true
    }
  }
  const stop = async () => {
    await savingDraft.current
    const value = await act('stop')
    if (value) {
      files.restore(value.draftAttachments ?? [])
      setDraft((current) =>
        !current ||
        value.draft === current ||
        value.draft.startsWith(`${current}\n\n`)
          ? value.draft
          : [current, value.draft].filter(Boolean).join('\n\n'),
      )
    }
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
    (working
      ? chat.partial?.model || model || chat.model
      : model || chat.nextModel) ||
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
    <div className="aico-chat" data-typing={typing || undefined}>
      <ChatHeader
        chat={chat}
        disconnected={disconnected}
        busy={busy}
        working={working}
        inputRef={input}
        onBack={() => (onBack ? onBack() : router.push('/'))}
        onReconnect={reconnect}
        onStop={() => void stop()}
        onResume={() =>
          void act('resume', {
            ...(model && { model }),
            ...(effort !== null && { effort: effort || null }),
          })
        }
        onDetails={() => setDetails(!details)}
      />
      <div className="chat-layout">
        <div className="chat-main">
          <div
            className="chat-body"
            ref={scroll.body}
            onScroll={scroll.onScroll}
          >
            <ChatTranscript
              chat={chat}
              disconnected={disconnected}
              connectedAt={connectedAt}
              busy={busy}
              working={working}
              model={model}
              selectedModel={selectedModel}
              copied={copied}
              onBranch={(message) => {
                setBranch(message)
                setBranchModel(message.model ?? selectedModel)
                setBranchDraft('')
              }}
              onCopy={(text) => void copy(text)}
              onAnswer={(ask, option) => void act('answer', { ask, option })}
            />
          </div>
          {error && (
            <p role="alert" className="chat-notice">
              {error}
            </p>
          )}
          {!ended && (
            <ChatComposer
              chat={chat}
              draft={draft}
              files={files}
              busy={busy}
              disconnected={disconnected}
              working={working}
              selectedModel={selectedModel}
              effort={effort}
              inputRef={input}
              onDraft={setDraft}
              onModel={setModel}
              onEffort={setEffort}
              onSend={() => void send()}
              onStop={() => void stop()}
              onAttach={() => setAttaching(true)}
              onFocus={() => {
                setTyping(true)
                scroll.followEnd()
              }}
              onBlur={() => {
                setTyping(false)
                saveDraft()
              }}
            />
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
      {attaching && (
        <ChatAttachmentSheet
          open={attaching}
          onOpenChange={setAttaching}
          onFiles={files.add}
        />
      )}
      <ChatBranchDialog
        branch={branch}
        chain={chat.chain}
        message={branchDraft}
        model={branchModel}
        busy={busy}
        error={error}
        onMessage={setBranchDraft}
        onModel={setBranchModel}
        onClose={() => setBranch(null)}
        onStart={() => void startBranch()}
      />
    </div>
  )
}
