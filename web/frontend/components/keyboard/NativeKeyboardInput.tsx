'use client'

import { useCallback, useId, useRef, useState } from 'react'
import {
  type ATermInputHandler,
  KEYBOARD_SPACING_METRICS,
  type KeyboardSizePreset,
  type KeyboardSpacingPreset,
  NATIVE_INPUT_HEIGHTS,
} from './types'

const BACKSPACE_SEQUENCE = '\x7f'
const MAX_NATIVE_BUFFER = 48

function getSharedPrefixLength(previous: string, next: string): number {
  const maxLength = Math.min(previous.length, next.length)
  let index = 0
  while (index < maxLength && previous[index] === next[index]) {
    index += 1
  }
  return index
}

function getSharedSuffixLength(
  previous: string,
  next: string,
  sharedPrefixLength: number,
): number {
  const previousRemaining = previous.length - sharedPrefixLength
  const nextRemaining = next.length - sharedPrefixLength
  const maxLength = Math.min(previousRemaining, nextRemaining)
  let index = 0

  while (
    index < maxLength &&
    previous[previous.length - 1 - index] === next[next.length - 1 - index]
  ) {
    index += 1
  }

  return index
}

export function getNativeKeyboardDelta(previous: string, next: string) {
  if (previous === next) {
    return { backspaces: 0, insertedText: '' }
  }

  const sharedPrefixLength = getSharedPrefixLength(previous, next)
  const sharedSuffixLength = getSharedSuffixLength(
    previous,
    next,
    sharedPrefixLength,
  )
  const removedLength =
    previous.length - sharedPrefixLength - sharedSuffixLength
  const insertedText = next.slice(
    sharedPrefixLength,
    next.length - sharedSuffixLength,
  )

  return {
    backspaces: Math.max(removedLength, 0),
    insertedText,
  }
}

interface NativeKeyboardInputProps {
  onSend: ATermInputHandler
  keyboardSize?: KeyboardSizePreset
  keyboardSpacing?: KeyboardSpacingPreset
  inputRef?: React.RefObject<HTMLInputElement | null>
}

export function NativeKeyboardInput({
  onSend,
  keyboardSize = 'medium',
  keyboardSpacing = 'normal',
  inputRef,
}: NativeKeyboardInputProps) {
  const fallbackRef = useRef<HTMLInputElement>(null)
  const resolvedRef = inputRef ?? fallbackRef
  const [value, setValue] = useState('')
  const bufferRef = useRef('')
  const inputId = useId()
  const spacing = KEYBOARD_SPACING_METRICS[keyboardSpacing]
  const inputHeight = NATIVE_INPUT_HEIGHTS[keyboardSize]

  const commitValue = useCallback(
    (nextValue: string) => {
      const { backspaces, insertedText } = getNativeKeyboardDelta(
        bufferRef.current,
        nextValue,
      )

      if (backspaces > 0) {
        onSend(BACKSPACE_SEQUENCE.repeat(backspaces))
      }
      if (insertedText) {
        onSend(insertedText)
      }

      const trimmedValue =
        nextValue.length > MAX_NATIVE_BUFFER
          ? nextValue.slice(-MAX_NATIVE_BUFFER)
          : nextValue

      bufferRef.current = trimmedValue
      setValue(trimmedValue)
    },
    [onSend],
  )

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      commitValue(event.target.value)
    },
    [commitValue],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') {
        return
      }

      event.preventDefault()
      onSend('\r')
      bufferRef.current = ''
      setValue('')
    },
    [onSend],
  )

  return (
    <div
      className="flex flex-col"
      style={{
        gap: spacing.nativeInputGap,
        padding: `0 ${spacing.controlPaddingX}px`,
      }}
    >
      <label
        htmlFor={inputId}
        className="text-[11px] font-semibold uppercase tracking-[0.14em]"
        style={{ color: 'var(--term-text-muted)' }}
      >
        Native Keyboard
      </label>
      <input
        id={inputId}
        ref={resolvedRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Tap here to type with native autocomplete"
        autoComplete="on"
        autoCorrect="on"
        autoCapitalize="none"
        spellCheck={true}
        enterKeyHint="enter"
        className="term-input w-full rounded-md px-3 text-sm focus:outline-none"
        style={{
          minHeight: inputHeight,
          backgroundColor: 'var(--term-bg-elevated)',
          border: '1px solid var(--term-border)',
          color: 'var(--term-text-primary)',
          borderRadius: spacing.keyRadius,
        }}
      />
    </div>
  )
}
