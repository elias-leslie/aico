import './tokens.css'
import '../../assets/fonts/fonts.css'
import './chrome.css'
import './control-surface.css'
// The frame (titlebar, menu, palette, toast) is the same for every window; what
// fills it depends on the session: an Agent Hub chat draws the shared chat view,
// every other session a terminal. Main decides from the session's backend.
import './window-frame'
import './hosts-panel'

const chat = await window.aico.chat.info()
if (chat) {
  const { mountChat } = await import('./chat/mount')
  await mountChat(chat)
} else {
  await import('./terminal-view')
}
