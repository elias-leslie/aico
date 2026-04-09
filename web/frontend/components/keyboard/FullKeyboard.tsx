'use client'

import { useEffect, useRef } from 'react'
import Keyboard from 'simple-keyboard'
import 'simple-keyboard/build/css/index.css'
import { getKeyboardStyles } from './FullKeyboard.styles'
import { KEYBOARD_DISPLAY, KEYBOARD_LAYOUT } from './keyboardLayouts'
import { useModifiers } from './ModifierContext'
import {
  type ATermInputHandler,
  KEYBOARD_SIZE_HEIGHTS,
  type KeyboardSizePreset,
} from './types'
import { useKeyboardHandler } from './useKeyboardHandler'
import { useKeyboardInput } from './useKeyboardInput'

interface FullKeyboardProps {
  onSend: ATermInputHandler
  keyboardSize?: KeyboardSizePreset
}

function FullKeyboardInner({
  onSend,
  keyboardSize = 'medium',
}: FullKeyboardProps) {
  const keyboardRef = useRef<Keyboard | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { sendKey, sendRaw, modifiers } = useKeyboardInput({ onSend })
  const { toggleModifier } = useModifiers()
  const rowHeight = KEYBOARD_SIZE_HEIGHTS[keyboardSize]

  const handleKeyPress = useKeyboardHandler({
    sendKey,
    sendRaw,
    toggleModifier,
    keyboardRef,
  })

  // Initialize simple-keyboard
  useEffect(() => {
    if (!containerRef.current) return

    const keyboard = new Keyboard(containerRef.current, {
      onKeyPress: handleKeyPress,
      layout: KEYBOARD_LAYOUT,
      display: KEYBOARD_DISPLAY,
      layoutName: 'default',
      theme: 'hg-theme-default a-term-keyboard-theme',
      mergeDisplay: true,
      physicalKeyboardHighlight: false,
      physicalKeyboardHighlightPress: false,
      disableButtonHold: false,
    })

    keyboardRef.current = keyboard
    return () => keyboard.destroy()
  }, [handleKeyPress])

  // Update modifier button styles
  useEffect(() => {
    if (!keyboardRef.current) return

    const shiftClass =
      modifiers.shift === 'sticky'
        ? 'modifier-sticky'
        : modifiers.shift === 'locked'
          ? 'modifier-locked'
          : ''

    keyboardRef.current.setOptions({
      buttonTheme: [
        ...(shiftClass ? [{ class: shiftClass, buttons: '{shift}' }] : []),
        { class: 'accent-key', buttons: '{shift} {bksp} {enter}' },
        { class: 'wide-key', buttons: '{sym} {abc}' },
      ],
    })
  }, [modifiers])

  return (
    <div
      className="a-term-keyboard-container"
      style={{ backgroundColor: 'var(--term-bg-surface)' }}
    >
      <div ref={containerRef} className="a-term-simple-keyboard" />
      <style>{getKeyboardStyles(rowHeight)}</style>
    </div>
  )
}

export function FullKeyboard(props: FullKeyboardProps) {
  // ModifierProvider is expected to be at parent level (MobileKeyboard)
  return <FullKeyboardInner {...props} />
}
