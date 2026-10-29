// The chat view of an Agent Hub session window: the shared chat view on a
// transport that reaches Agent Hub only through the preload bridge.

import { createRoot } from 'react-dom/client'
import { ChatRoot } from '../../shared/chat/chat-view'
import type { ChatInfo } from '../../shared/chat/types'
import { arcade, eyes } from '../window-frame'

/** The eyes read along and the tray goes amber while a turn runs, as for a terminal that prints. */
function showBusy(busy: boolean): void {
  eyes?.setBusy(busy)
  arcade?.output(busy)
  window.aico.win.setThinking(busy)
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

  createRoot(host).render(
    <ChatRoot
      info={info}
      transport={window.aico.chat}
      onBusy={info.readOnly ? undefined : showBusy}
      recovery="Close this window and reopen the session from the menu."
    />,
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
