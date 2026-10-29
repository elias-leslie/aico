// The chat view of an Agent Hub session window: the shared chat component on
// a client that reaches Agent Hub only through the preload bridge.

import '@agent-hub/chat-ui/chat-ui.css'
import './chat.css'
import { ChatClientProvider, ChatPanel } from '@agent-hub/chat-ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Component, type ReactNode, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ChatInfo } from '../../types'
import { arcade, eyes } from '../window-frame'
import { createBridgeClient } from './bridge-client'
import { ModelPicker } from './model-picker'

/** A crash in the chat view says so; it never leaves a blank window. */
class ChatBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
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
        <p>Close this window and reopen the session from the menu.</p>
      </div>
    )
  }
}

/** The eyes read along and the tray goes amber while a turn runs, as for a terminal that prints. */
function showBusy(busy: boolean): void {
  eyes?.setBusy(busy)
  arcade?.output(busy)
  window.aico.win.setThinking(busy)
}

function ChatView({ info }: { info: ChatInfo }) {
  // The session's own model to start with (what it was created or last sent with).
  const [model, setModel] = useState(info.requestedModel ?? '')
  const chosen = useRef(model)
  chosen.current = model
  const readOnly = info.readOnly === true
  const client = useMemo(
    () =>
      createBridgeClient(
        window.aico.chat,
        info,
        readOnly
          ? {}
          : {
              model: () => chosen.current || null,
              onBusy: showBusy,
            },
      ),
    [info, readOnly],
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

export async function mountChat(info: ChatInfo): Promise<void> {
  const host = document.getElementById('chat-root')
  const terminal = document.getElementById('terminal')
  if (!host) throw new Error('chat mount point missing')
  if (terminal) terminal.hidden = true
  host.hidden = false
  document.documentElement.dataset.view = 'chat'
  // A workflow step's attempt is read, not written to: the stylesheet drops the message box.
  if (info.readOnly) host.dataset.readonly = 'true'

  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 60_000 } },
  })

  createRoot(host).render(
    <ChatBoundary>
      <QueryClientProvider client={queries}>
        <ChatView info={info} />
      </QueryClientProvider>
    </ChatBoundary>,
  )

  // A window that comes forward types into the message box without a click, and the
  // palette and menu hand focus back to it when they close.
  const focusInput = () => {
    if (!info.readOnly) host.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }
  window.addEventListener('aico:refocus', focusInput)
  window.aico.win.onFocusChange((focused) => {
    if (focused) focusInput()
  })
}
