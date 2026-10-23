'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { KEY_ROW_METRICS, keepKeyboardOpen, remSize } from './types'

type ComposeAction = 'insert' | 'send'
const drafts = new Map<string, string>()
const draftRevisions = new Map<string, number>()
const pendingCommits = new Map<string, symbol>()
const pendingListeners = new Set<() => void>()

function subscribePending(listener: () => void) {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

function notifyPending() {
  for (const listener of pendingListeners) listener()
}

interface NativeKeyboardInputProps {
  sessionId: string
  connected: boolean
  onCommit: (
    sessionId: string,
    text: string,
    action: ComposeAction,
  ) => Promise<boolean>
  onFocusChange?: (focused: boolean) => void
  inputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  phone?: boolean
  ctrlActive?: boolean
  onCtrlLetter?: (letter: string) => void
  onCtrlCancel?: () => void
}

function draftStorageKey(sessionId: string) {
  return `a-term-compose:${sessionId}`
}

function readDraft(key: string): string {
  return drafts.get(key) ?? ''
}

function saveDraft(key: string, value: string) {
  if (value) drafts.set(key, value)
  else drafts.delete(key)
  const revision = (draftRevisions.get(key) ?? 0) + 1
  draftRevisions.set(key, revision)
  return revision
}

/** The desktop box is one line, as the desktop mockup's. */
const DESKTOP_COMPOSE_HEIGHT = 38

export function isComposePending(sessionId: string | null | undefined) {
  return Boolean(sessionId && pendingCommits.has(draftStorageKey(sessionId)))
}

export function NativeKeyboardInput({
  sessionId,
  connected,
  onCommit,
  onFocusChange,
  inputRef,
  phone = false,
  ctrlActive = false,
  onCtrlLetter,
  onCtrlCancel,
}: NativeKeyboardInputProps) {
  const fallbackRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const resolvedRef = inputRef ?? fallbackRef
  const assignInputRef = useCallback(
    (element: HTMLInputElement | HTMLTextAreaElement | null) => {
      resolvedRef.current = element
    },
    [resolvedRef],
  )
  const storageKey = draftStorageKey(sessionId)
  const [value, setValue] = useState(() => readDraft(storageKey))
  const [busy, setBusy] = useState(false)
  const pendingForSession = useSyncExternalStore(
    subscribePending,
    () => pendingCommits.has(storageKey),
    () => false,
  )
  const [failed, setFailed] = useState<ComposeAction | null>(null)
  const composingRef = useRef(false)
  const busyRef = useRef(false)
  const inputHeight = remSize(KEY_ROW_METRICS.composeHeight)

  useEffect(() => {
    if (!pendingForSession) setValue(readDraft(storageKey))
  }, [storageKey, pendingForSession])

  useLayoutEffect(() => {
    if (!phone) return
    const field = resolvedRef.current
    if (!(field instanceof HTMLTextAreaElement)) return

    field.style.height = 'auto'
    if (!value) {
      field.style.overflowY = 'hidden'
      return
    }
    const maxHeight = 120
    if (field.scrollHeight > 0) {
      field.style.height = `${Math.min(field.scrollHeight, maxHeight)}px`
    }
    field.style.overflowY = field.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [phone, resolvedRef, value])

  const commit = useCallback(
    async (action: ComposeAction) => {
      if (
        busyRef.current ||
        pendingCommits.has(storageKey) ||
        composingRef.current ||
        !connected
      )
        return
      // Read the DOM value so a phone's last autocorrect replacement is used.
      const text = resolvedRef.current?.value ?? value
      if (!text || (action === 'send' && /[\r\n]/.test(text))) return

      // The phone may commit autocorrect into the DOM just before Enter,
      // before React has dispatched change. Retain that exact text on failure.
      const submittedRevision = saveDraft(storageKey, text)
      setValue(text)
      const operation = Symbol(storageKey)
      pendingCommits.set(storageKey, operation)
      notifyPending()
      busyRef.current = true
      setBusy(true)
      setFailed(null)
      try {
        if (await onCommit(sessionId, text, action)) {
          if (draftRevisions.get(storageKey) === submittedRevision) {
            saveDraft(storageKey, '')
            setValue('')
          }
        } else {
          setFailed(action)
        }
      } catch {
        setFailed(action)
      } finally {
        busyRef.current = false
        if (pendingCommits.get(storageKey) === operation) {
          pendingCommits.delete(storageKey)
          notifyPending()
        }
        setBusy(false)
      }
    },
    [connected, onCommit, resolvedRef, sessionId, storageKey, value],
  )

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = event.target.value
      if (phone && ctrlActive && !composingRef.current) {
        let inserted: string | undefined
        if (next.length === value.length + 1) {
          let index = 0
          while (index < value.length && value[index] === next[index]) index++
          if (next.slice(index + 1) === value.slice(index))
            inserted = next[index]
        }
        if (inserted && /^[a-z]$/i.test(inserted)) {
          onCtrlLetter?.(inserted)
          event.target.value = value
          return
        }
        onCtrlCancel?.()
      }
      setValue(next)
      saveDraft(storageKey, next)
      setFailed(null)
    },
    [ctrlActive, phone, onCtrlCancel, onCtrlLetter, storageKey, value],
  )

  const interrupted = failed && (
    <span
      role="alert"
      className="px-0.5 text-xs"
      style={{ color: 'var(--bone)' }}
    >
      {failed === 'send' ? 'Send' : 'Insert'} was interrupted. Check the session
      before retrying; your draft is saved.
    </span>
  )
  const lineBreakHint = /\r|\n/.test(value) && (
    <span className="px-0.5 text-xs" style={{ color: 'var(--mist)' }}>
      Remove line breaks to send this draft.
    </span>
  )
  const cannotSend =
    !connected || !value || /[\r\n]/.test(value) || busy || pendingForSession

  if (phone) {
    return (
      <div className="lantern-compose">
        <div className="lantern-compose-row">
          <textarea
            ref={assignInputRef}
            rows={1}
            aria-label="Compose"
            value={value}
            readOnly={busy || pendingForSession}
            onChange={handleChange}
            onCompositionStart={() => {
              composingRef.current = true
              if (ctrlActive) onCtrlCancel?.()
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            onFocus={() => onFocusChange?.(true)}
            onBlur={() => onFocusChange?.(false)}
            onKeyDown={(event) => {
              if (
                ctrlActive &&
                !composingRef.current &&
                /^[a-z]$/i.test(event.key)
              ) {
                event.preventDefault()
                onCtrlLetter?.(event.key)
                return
              }
              if (
                event.key !== 'Enter' ||
                event.nativeEvent.isComposing ||
                composingRef.current ||
                event.keyCode === 229
              )
                return
              event.preventDefault()
              void commit('send')
            }}
            placeholder="Type, correct, then send"
            autoComplete="on"
            autoCorrect="on"
            autoCapitalize="none"
            spellCheck={true}
            enterKeyHint="send"
            style={{ minHeight: inputHeight, maxHeight: 120 }}
          />
          <button
            type="button"
            onPointerDown={keepKeyboardOpen}
            onClick={() => void commit('send')}
            disabled={cannotSend}
            className="lantern-btn primary"
            style={{ height: inputHeight }}
          >
            Send
          </button>
        </div>
        {interrupted}
        {lineBreakHint}
      </div>
    )
  }

  return (
    <div className="lantern-compose">
      <div className="lantern-compose-row items-center!">
        <input
          ref={assignInputRef}
          type="text"
          aria-label="Compose"
          value={value}
          readOnly={busy}
          onChange={handleChange}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              event.nativeEvent.isComposing ||
              composingRef.current
            )
              return
            event.preventDefault()
            void commit('insert')
          }}
          placeholder="Type, correct, then insert"
          autoComplete="on"
          autoCorrect="on"
          autoCapitalize="none"
          spellCheck={true}
          enterKeyHint="done"
          style={{ height: DESKTOP_COMPOSE_HEIGHT }}
        />
        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={() => void commit('insert')}
          disabled={!connected || !value || busy}
          className="lantern-btn"
          style={{ height: DESKTOP_COMPOSE_HEIGHT }}
        >
          Insert
        </button>
        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={() => void commit('send')}
          disabled={cannotSend}
          className="lantern-btn primary"
          style={{ height: DESKTOP_COMPOSE_HEIGHT }}
        >
          Send
        </button>
      </div>
      {interrupted}
      {lineBreakHint}
    </div>
  )
}
