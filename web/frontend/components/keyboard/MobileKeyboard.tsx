'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { forwardClipboardPaste } from '@/lib/hooks/terminal-instance-utils'
import { ControlBar } from './ControlBar'
import { arrowSequence, ctrlLetter, KEY_SEQUENCES } from './keyMappings'
import { caretMoves, charCount, editKeys, typingEdit } from './phoneTyping'
import type { TerminalInputHandler } from './types'

interface MobileKeyboardProps {
  sessionId: string | null | undefined
  onSend: TerminalInputHandler
  /** Sends text as one bracketed paste: nothing runs until Enter. */
  onPaste: (text: string) => void
  onFilePaste?: (file: File) => void
}

const ARROW_KEYS = {
  ArrowLeft: 'left',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowRight: 'right',
} as const

/** The field's caret, in characters. */
function fieldCaret(field: HTMLTextAreaElement): number {
  return charCount(
    field.value.slice(0, field.selectionEnd ?? field.value.length),
  )
}

/**
 * The phone's input: its own keyboard types straight into the session, as in
 * any terminal app, with a slim key row for the keys it lacks.
 *
 * The keyboard needs a focused text field, so a hidden one takes the typing.
 * Each edit the keyboard makes there (a letter, Backspace, a swipe-typed word,
 * a cursor drag) is replayed as keys at the session's cursor; the session's
 * own prompt shows the text. The field keeps only what was typed since the
 * last Enter or key-row key, for the keyboard's sake.
 */
export function MobileKeyboard({
  sessionId,
  onSend,
  onPaste,
  onFilePaste,
}: MobileKeyboardProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  const [ctrlActive, setCtrlActive] = useState(false)
  const ctrlRef = useRef(false)
  // The field text the session has, and the session's cursor in it.
  const typedRef = useRef({ text: '', caret: 0 })
  const composingRef = useRef(false)
  const resetPendingRef = useRef(false)
  const viewportBeforeFocusRef = useRef<number | null>(null)
  const keyboardSeenRef = useRef(false)

  const setCtrl = useCallback((on: boolean) => {
    ctrlRef.current = on
    setCtrlActive(on)
  }, [])

  const resetField = useCallback(() => {
    if (composingRef.current) {
      resetPendingRef.current = true
      return
    }
    resetPendingRef.current = false
    if (fieldRef.current) fieldRef.current.value = ''
    typedRef.current = { text: '', caret: 0 }
  }, [])

  // A key outside the typed text moves the session's line on its own terms.
  const sendKey = useCallback(
    (sequence: string) => {
      resetField()
      setCtrl(false)
      onSend(sequence)
    },
    [onSend, resetField, setCtrl],
  )

  const handleInput = useCallback(() => {
    const field = fieldRef.current
    if (!field) return
    const before = typedRef.current
    const newCaret = fieldCaret(field)
    const edit = typingEdit(before.text, field.value, before.caret, newCaret)

    if (ctrlRef.current) {
      setCtrl(false)
      if (
        !composingRef.current &&
        edit.deletes === 0 &&
        /^[a-z]$/i.test(edit.insert)
      ) {
        onSend(ctrlLetter(edit.insert))
        field.value = before.text
        const index = Array.from(before.text)
          .slice(0, before.caret)
          .join('').length
        field.setSelectionRange(index, index)
        return
      }
    }

    if (/[\r\n]/.test(edit.insert)) {
      // Enter, or several lines at once from the keyboard's clipboard.
      if (/^[\r\n]$/.test(edit.insert))
        onSend(editKeys(edit) + KEY_SEQUENCES.ENTER)
      else {
        onSend(editKeys(edit))
        onPaste(edit.insert)
      }
      typedRef.current = { text: field.value, caret: newCaret }
      resetField()
      return
    }

    const keys =
      editKeys(edit) + edit.insert + caretMoves(newCaret - edit.caret)
    if (keys) onSend(keys)
    typedRef.current = { text: field.value, caret: newCaret }
  }, [onPaste, onSend, resetField, setCtrl])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || composingRef.current) return
      const { key } = event
      const field = event.currentTarget
      const handled = (sequence: string) => {
        event.preventDefault()
        sendKey(sequence)
      }
      if (key === 'Enter') return handled(KEY_SEQUENCES.ENTER)
      if (key === 'Escape') return handled(KEY_SEQUENCES.ESC)
      if (key === 'Tab')
        return handled(event.shiftKey ? '\x1b[Z' : KEY_SEQUENCES.TAB)
      if (key in ARROW_KEYS)
        return handled(
          arrowSequence(ARROW_KEYS[key as keyof typeof ARROW_KEYS], {
            shift: event.shiftKey,
            alt: event.altKey,
            ctrl: event.ctrlKey || ctrlRef.current,
          }),
        )
      if (
        /^[a-z]$/i.test(key) &&
        !event.metaKey &&
        (event.ctrlKey || ctrlRef.current)
      )
        return handled(ctrlLetter(key))
      // Nothing in the field before the caret: the keyboard would delete
      // nothing, but the session's prompt may have text to delete.
      if (
        key === 'Backspace' &&
        field.selectionStart === 0 &&
        field.selectionEnd === 0
      ) {
        event.preventDefault()
        setCtrl(false)
        onSend(KEY_SEQUENCES.BACKSPACE)
      }
    },
    [onSend, sendKey, setCtrl],
  )

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      setCtrl(false)
      forwardClipboardPaste(event.nativeEvent, onPaste, onFilePaste)
    },
    [onFilePaste, onPaste, setCtrl],
  )

  const handleToggleKeyboard = useCallback(() => {
    const field = fieldRef.current
    if (!field) return
    if (focused) {
      field.blur()
      return
    }
    viewportBeforeFocusRef.current =
      window.visualViewport?.height ?? window.innerHeight
    keyboardSeenRef.current = false
    // iOS requires focus to stay in the same user gesture as the tap.
    field.focus({ preventScroll: true })
  }, [focused])

  // What was typed belongs to the session it went to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the session changes
  useEffect(() => {
    resetField()
    setCtrl(false)
  }, [sessionId, resetField, setCtrl])

  // The keyboard's cursor drag moves the field's caret without an edit; move
  // the session's cursor with it.
  useEffect(() => {
    if (!focused) return
    const handleSelectionChange = () => {
      const field = fieldRef.current
      const typed = typedRef.current
      if (
        !field ||
        document.activeElement !== field ||
        composingRef.current ||
        field.value !== typed.text
      )
        return
      const caret = fieldCaret(field)
      if (caret === typed.caret) return
      onSend(caretMoves(caret - typed.caret))
      typedRef.current = { ...typed, caret }
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () =>
      document.removeEventListener('selectionchange', handleSelectionChange)
  }, [focused, onSend])

  // Closing the phone's keyboard (back gesture, keyboard's own button) leaves
  // the field focused; blur it so the key row offers to show it again.
  useEffect(() => {
    if (!focused) return
    const viewport = window.visualViewport
    const before =
      viewportBeforeFocusRef.current ?? viewport?.height ?? window.innerHeight
    if (!viewport || !before) return
    const handleViewportResize = () => {
      const shrink = before - viewport.height
      // A software keyboard takes a substantial part of the phone viewport;
      // small browser-chrome changes should not count as closing it.
      if (shrink > before * 0.2) keyboardSeenRef.current = true
      if (keyboardSeenRef.current && shrink < before * 0.08) {
        fieldRef.current?.blur()
      }
    }
    viewport.addEventListener('resize', handleViewportResize)
    return () => viewport.removeEventListener('resize', handleViewportResize)
  }, [focused])

  return (
    <div
      className="relative flex shrink-0 flex-col overflow-visible pt-1.5"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <textarea
        ref={fieldRef}
        rows={1}
        aria-label="Type into the session"
        className="phone-typing-field"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          // Safari ends the composition before its last input event.
          if (resetPendingRef.current) setTimeout(resetField, 0)
        }}
        onFocus={() => {
          setFocused(true)
          if (viewportBeforeFocusRef.current === null)
            viewportBeforeFocusRef.current =
              window.visualViewport?.height ?? window.innerHeight
        }}
        onBlur={() => {
          setFocused(false)
          viewportBeforeFocusRef.current = null
          keyboardSeenRef.current = false
          resetField()
        }}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        inputMode="text"
        enterKeyHint="enter"
      />
      <ControlBar
        onSend={sendKey}
        ctrlActive={ctrlActive}
        onCtrlToggle={() => setCtrl(!ctrlRef.current)}
        keyboardOpen={focused}
        onToggleKeyboard={handleToggleKeyboard}
      />
    </div>
  )
}
