// The chat view of an Agent Hub session window: the shared chat component on
// a client that reaches Agent Hub only through the preload bridge.

import '@agent-hub/chat-ui/chat-ui.css'
import './chat.css'
import { ChatClientProvider, ChatPanel } from '@agent-hub/chat-ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ChatInfo } from '../../types'
import { createBridgeClient } from './bridge-client'

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

export async function mountChat(info: ChatInfo): Promise<void> {
  const host = document.getElementById('chat-root')
  const terminal = document.getElementById('terminal')
  if (!host) throw new Error('chat mount point missing')
  if (terminal) terminal.hidden = true
  host.hidden = false
  document.documentElement.dataset.view = 'chat'

  const client = createBridgeClient(window.aico.chat, info)
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 60_000 } },
  })

  createRoot(host).render(
    <ChatBoundary>
      <QueryClientProvider client={queries}>
        <ChatClientProvider client={client}>
          <ChatPanel
            agentSlug={info.agentSlug}
            sessionId={info.sessionId}
            layout="compact"
            toolsEnabled
            allowModelMentions={false}
          />
        </ChatClientProvider>
      </QueryClientProvider>
    </ChatBoundary>,
  )

  // A window that comes forward types into the message box without a click, and the
  // palette and menu hand focus back to it when they close.
  const focusInput = () => host.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  window.addEventListener('aico:refocus', focusInput)
  window.aico.win.onFocusChange((focused) => {
    if (focused) focusInput()
  })
}
