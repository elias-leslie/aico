import type { Terminal } from '@xterm/xterm'

export function canSendDraft(text: string, tuiSlug: string): boolean {
  return (
    tuiSlug !== 'shell' &&
    text.length > 0 &&
    ![...text].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
}

/** An ordinary editable field lets Chromium spellcheck and IME finish before
 * bytes reach the terminal. The field belongs to this widget's renderer and
 * stays in memory when the tmux transport disconnects. */
export function wireDraftInput(
  term: Terminal,
  getTuiSlug: () => string,
  layoutChanged: () => void,
): void {
  const section = document.querySelector<HTMLElement>('#draft-composer')
  const editor = document.querySelector<HTMLTextAreaElement>('#draft-text')
  const insert = document.querySelector<HTMLButtonElement>('#draft-insert')
  const send = document.querySelector<HTMLButtonElement>('#draft-send')
  const close = document.querySelector<HTMLButtonElement>('#draft-close')
  const status = document.querySelector<HTMLElement>('#draft-status')
  if (!section || !editor || !insert || !send || !close || !status) {
    throw new Error('draft composer controls missing')
  }

  let composing = false
  let activeSessionId: string | null = null
  const drafts = new Map<string, string>()
  const update = (): void => {
    insert.disabled = composing || editor.value.length === 0
    send.hidden = getTuiSlug() === 'shell'
    send.disabled = composing || !canSendDraft(editor.value, getTuiSlug())
    send.title = editor.value.includes('\n')
      ? 'Send accepts one line; use Insert for multiple lines'
      : 'Send one line to this TUI'
  }
  const show = (): void => {
    section.hidden = false
    update()
    layoutChanged()
    editor.focus()
  }
  const hide = (): void => {
    section.hidden = true
    layoutChanged()
    term.focus()
  }
  close.addEventListener('click', hide)
  window.addEventListener('aico:compose-open', show)
  editor.addEventListener('input', () => {
    if (activeSessionId) drafts.set(activeSessionId, editor.value)
    status.textContent = 'Draft stays here until you insert it.'
    update()
  })
  editor.addEventListener('compositionstart', () => {
    composing = true
    update()
  })
  editor.addEventListener('compositionend', () => {
    composing = false
    update()
  })
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !composing) {
      event.preventDefault()
      hide()
    }
  })
  const insertDraft = (submit: boolean): void => {
    if (composing || editor.value.length === 0) return
    if (submit && !canSendDraft(editor.value, getTuiSlug())) return
    // xterm's paste path respects the attached program's bracketed-paste mode.
    // Aico's IPC input has no acknowledgement, so keep the draft available if
    // the terminal is temporarily disconnected or rejects input.
    term.paste(editor.value)
    if (submit) window.aico.pty.input('\r')
    status.textContent = submit ? 'Sent. Draft kept.' : 'Inserted. Draft kept.'
    editor.focus()
    editor.select()
  }
  insert.addEventListener('click', () => insertDraft(false))
  send.addEventListener('click', () => insertDraft(true))
  window.aico.win.onTitle((info) => {
    if (info.sessionId && info.sessionId !== activeSessionId) {
      if (activeSessionId) drafts.set(activeSessionId, editor.value)
      editor.value = drafts.get(info.sessionId) ?? (activeSessionId ? '' : editor.value)
      activeSessionId = info.sessionId
      status.textContent = 'Draft stays here until you insert it.'
    }
    update()
  })
  update()
}
