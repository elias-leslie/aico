// The Agent Hub chat view, drawn the same in the desktop window and the web app:
// the shared chat component (transcript layout) on a client that reaches Agent
// Hub only through a chat transport, plus the model select in its composer.

import '@agent-hub/chat-ui/chat-ui.css'
import './chat.css'
import { ChatClientProvider, ChatPanel } from '@agent-hub/chat-ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Component, type ReactNode, useMemo, useRef, useState } from 'react'
import { createBridgeClient } from './bridge-client'
import { ModelPicker } from './model-picker'
import type { ChatInfo, ChatTransport } from './types'

/** A crash in the chat view says so; it never leaves a blank window. */
class ChatBoundary extends Component<
  { children: ReactNode; recovery: string },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error('[aico] chat view failed:', error instanceof Error ? error.message : 'unknown')
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="chat-failed">
        <p>The chat view stopped working.</p>
        <p>{this.props.recovery}</p>
      </div>
    )
  }
}

function ChatView({
  info,
  transport,
  onBusy,
}: {
  info: ChatInfo
  transport: ChatTransport
  onBusy?: (busy: boolean) => void
}) {
  // The session's own model to start with (what it was created or last sent with).
  const [model, setModel] = useState(info.requestedModel ?? '')
  const chosen = useRef(model)
  chosen.current = model
  const readOnly = info.readOnly === true
  const client = useMemo(
    () =>
      createBridgeClient(
        transport,
        info,
        readOnly
          ? {}
          : {
              model: () => chosen.current || null,
              onBusy,
            },
      ),
    [transport, info, readOnly, onBusy],
  )
  return (
    <ChatClientProvider client={client}>
      <ChatPanel
        agentSlug={info.agentSlug}
        sessionId={info.sessionId}
        layout="transcript"
        toolsEnabled
        allowModelMentions={false}
        branch={info.branch ?? null}
        config={{ model: model || null }}
        renderComposerControls={
          readOnly
            ? undefined
            : () => <ModelPicker client={client} value={model} onChange={setModel} />
        }
      />
    </ChatClientProvider>
  )
}

const newQueries = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 60_000 } },
  })

export interface ChatRootProps {
  info: ChatInfo
  transport: ChatTransport
  /** A turn is running (its events are arriving), or none is. */
  onBusy?: (busy: boolean) => void
  /** What the owner does when the view crashes (the host's own words). */
  recovery: string
}

/** The chat view with its own query cache and crash guard. Give it a stable `transport` and `onBusy`. */
export function ChatRoot({ info, transport, onBusy, recovery }: ChatRootProps) {
  const queries = useMemo(newQueries, [])
  return (
    <ChatBoundary recovery={recovery}>
      <QueryClientProvider client={queries}>
        <ChatView info={info} transport={transport} onBusy={onBusy} />
      </QueryClientProvider>
    </ChatBoundary>
  )
}
