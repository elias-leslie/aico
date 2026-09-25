'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  KEYBOARD_SPACING_METRICS,
  type KeyboardSizePreset,
  type KeyboardSpacingPreset,
  NATIVE_INPUT_HEIGHTS,
  remSize,
} from './types'

type ComposeAction = 'insert' | 'send'
const drafts = new Map<string, string>()

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
  inputRef?: React.RefObject<HTMLInputElement | null>
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
}: NativeKeyboardInputProps) {
  const fallbackRef = useRef<HTMLInputElement>(null)
  const resolvedRef = inputRef ?? fallbackRef
  const storageKey = draftStorageKey(storageScopeId, sessionId)
  const [value, setValue] = useState(() => readDraft(storageKey))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const composingRef = useRef(false)
  const busyRef = useRef(false)
  const inputId = useId()
  const spacing = KEYBOARD_SPACING_METRICS[keyboardSpacing]
  const inputHeight = remSize(NATIVE_INPUT_HEIGHTS[keyboardSize])

  useEffect(() => {
    setValue(readDraft(storageKey))
  }, [storageKey])

  const commit = useCallback(
    async (action: ComposeAction) => {
      if (busyRef.current || composingRef.current || !connected) return
      // Read the DOM value so a phone's last autocorrect replacement is used.
      const text = resolvedRef.current?.value ?? value
      if (!text || (action === 'send' && /[\r\n]/.test(text))) return

      busyRef.current = true
      setBusy(true)
      setError(false)
      try {
        if (await onCommit(sessionId, text, action)) {
          saveDraft(storageKey, '')
          setValue('')
        } else {
          setError(true)
        }
      } catch {
        setError(true)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [connected, onCommit, resolvedRef, sessionId, storageKey, value],
  )

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value
      setValue(next)
      saveDraft(storageKey, next)
      setError(false)
    },
    [storageKey],
  )

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
          ref={resolvedRef}
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
