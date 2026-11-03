'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { keepKeyboardOpen } from './types'

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

export function NativeKeyboardInput({
  sessionId,
  connected,
  onCommit,
  onFocusChange,
  inputRef,
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

  useEffect(() => {
    if (!pendingForSession) setValue(readDraft(storageKey))
  }, [storageKey, pendingForSession])

  const commit = useCallback(
    async (action: ComposeAction) => {
      if (
        busyRef.current ||
        pendingCommits.has(storageKey) ||
        composingRef.current ||
        !connected
      )
        return
      // Read the DOM value so the last autocorrect replacement is used.
      const text = resolvedRef.current?.value ?? value
      if (!text || (action === 'send' && /[\r\n]/.test(text))) return

      // Autocorrect may commit into the DOM just before Enter, before React
      // has dispatched change. Retain that exact text on failure.
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
      setValue(next)
      saveDraft(storageKey, next)
      setFailed(null)
    },
    [storageKey],
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
  const cannotSend =
    !connected || !value || /[\r\n]/.test(value) || busy || pendingForSession

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
    </div>
  )
}
