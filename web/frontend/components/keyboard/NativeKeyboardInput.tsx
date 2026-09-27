'use client'

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  KEYBOARD_SPACING_METRICS,
  type KeyboardSizePreset,
  type KeyboardSpacingPreset,
  keepKeyboardOpen,
  NATIVE_INPUT_HEIGHTS,
  remSize,
} from './types'

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
  storageScopeId?: string | null
  connected: boolean
  onCommit: (
    sessionId: string,
    text: string,
    action: ComposeAction,
  ) => Promise<boolean>
  onFocusChange?: (focused: boolean) => void
  keyboardSize?: KeyboardSizePreset
  keyboardSpacing?: KeyboardSpacingPreset
  inputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  mobileOverlay?: boolean
  visible?: boolean
  onDraftPresenceChange?: (hasDraft: boolean) => void
  ctrlActive?: boolean
  onCtrlLetter?: (letter: string) => void
  onCtrlCancel?: () => void
}

function draftStorageKey(scope: string | null | undefined, sessionId: string) {
  return `a-term-compose:${scope ?? 'default'}:${sessionId}`
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

export function isComposePending(
  scope: string | null | undefined,
  sessionId: string | null | undefined,
) {
  return Boolean(
    sessionId && pendingCommits.has(draftStorageKey(scope, sessionId)),
  )
}

export function NativeKeyboardInput({
  sessionId,
  storageScopeId,
  connected,
  onCommit,
  onFocusChange,
  keyboardSize = 'medium',
  keyboardSpacing = 'normal',
  inputRef,
  mobileOverlay = false,
  visible = true,
  onDraftPresenceChange,
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
  const storageKey = draftStorageKey(storageScopeId, sessionId)
  const [value, setValue] = useState(() => readDraft(storageKey))
  const [busy, setBusy] = useState(false)
  const pendingForSession = useSyncExternalStore(
    subscribePending,
    () => pendingCommits.has(storageKey),
    () => false,
  )
  const [error, setError] = useState(false)
  const composingRef = useRef(false)
  const busyRef = useRef(false)
  const inputId = useId()
  const spacing = KEYBOARD_SPACING_METRICS[keyboardSpacing]
  const inputHeight = remSize(NATIVE_INPUT_HEIGHTS[keyboardSize])

  useEffect(() => {
    if (!pendingForSession) setValue(readDraft(storageKey))
  }, [storageKey, pendingForSession])

  useEffect(() => {
    onDraftPresenceChange?.(value.length > 0)
  }, [onDraftPresenceChange, value])

  useLayoutEffect(() => {
    if (!mobileOverlay || !visible) return
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
  }, [mobileOverlay, resolvedRef, value, visible])

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
      setError(false)
      try {
        if (await onCommit(sessionId, text, action)) {
          if (draftRevisions.get(storageKey) === submittedRevision) {
            saveDraft(storageKey, '')
            setValue('')
          }
        } else {
          setError(true)
        }
      } catch {
        setError(true)
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
      if (mobileOverlay && ctrlActive && !composingRef.current) {
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
      setError(false)
    },
    [ctrlActive, mobileOverlay, onCtrlCancel, onCtrlLetter, storageKey, value],
  )

  if (mobileOverlay) {
    return (
      <div
        hidden={!visible}
        className="absolute bottom-full left-0 right-0 z-20 flex flex-col gap-1 border-t p-2"
        style={{
          display: visible ? undefined : 'none',
          backgroundColor: 'var(--term-bg-surface)',
          borderColor: 'var(--term-border)',
        }}
      >
        <div className="flex items-end gap-2">
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
            className="term-input min-w-0 flex-1 resize-none rounded-md px-3 py-2 text-sm leading-5 focus:outline-none focus-visible:ring-2"
            style={{
              minHeight: inputHeight,
              maxHeight: 120,
              backgroundColor: 'var(--term-bg-elevated)',
              border: '1px solid var(--term-border)',
              color: 'var(--term-text-primary)',
              borderRadius: spacing.keyRadius,
            }}
          />
          <button
            type="button"
            onPointerDown={keepKeyboardOpen}
            onClick={() => void commit('send')}
            disabled={
              !connected ||
              !value ||
              /[\r\n]/.test(value) ||
              busy ||
              pendingForSession
            }
            className="rounded-md border px-2 text-xs font-semibold disabled:opacity-50 focus-visible:ring-2"
            style={{
              minHeight: inputHeight,
              borderColor: 'var(--term-border)',
              backgroundColor: 'var(--term-accent)',
              color: 'var(--term-accent-foreground)',
            }}
          >
            Send
          </button>
        </div>
        {error && (
          <span
            role="alert"
            className="text-xs"
            style={{ color: 'var(--term-error)' }}
          >
            Send was interrupted. Check the terminal before retrying; your draft
            is saved.
          </span>
        )}
        {/\r|\n/.test(value) && (
          <span className="text-xs" style={{ color: 'var(--term-text-muted)' }}>
            Remove line breaks to send this draft.
          </span>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex flex-col"
      style={{
        gap: spacing.nativeInputGap,
        padding: `0 ${spacing.controlPaddingX}px`,
        backgroundColor: 'var(--term-bg-surface)',
      }}
    >
      <label
        htmlFor={inputId}
        className="text-[11px] font-semibold uppercase tracking-[0.14em]"
        style={{ color: 'var(--term-text-muted)' }}
      >
        Compose
      </label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          ref={assignInputRef}
          type="text"
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
          className="term-input min-w-0 flex-1 rounded-md px-3 text-sm focus:outline-none focus-visible:ring-2"
          style={{
            minHeight: inputHeight,
            backgroundColor: 'var(--term-bg-elevated)',
            border: '1px solid var(--term-border)',
            color: 'var(--term-text-primary)',
            borderRadius: spacing.keyRadius,
          }}
        />
        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={() => void commit('insert')}
          disabled={!connected || !value || busy}
          className="rounded-md border px-2 text-xs font-semibold disabled:opacity-50 focus-visible:ring-2"
          style={{
            minHeight: inputHeight,
            borderColor: 'var(--term-border)',
            color: 'var(--term-text-primary)',
          }}
        >
          Insert
        </button>
        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={() => void commit('send')}
          disabled={!connected || !value || /[\r\n]/.test(value) || busy}
          className="rounded-md border px-2 text-xs font-semibold disabled:opacity-50 focus-visible:ring-2"
          style={{
            minHeight: inputHeight,
            borderColor: 'var(--term-border)',
            backgroundColor: 'var(--term-accent)',
            color: 'var(--term-accent-foreground)',
          }}
        >
          Send
        </button>
      </div>
      {error && (
        <span
          role="alert"
          className="text-xs"
          style={{ color: 'var(--term-error)' }}
        >
          Could not insert. Your draft is still here.
        </span>
      )}
    </div>
  )
}
