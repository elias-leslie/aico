import { useCallback, useRef } from 'react'
import type Keyboard from 'simple-keyboard'
import { KEY_SEQUENCES } from './keyMappings'
import type { ModifierStates } from './types'

interface UseKeyboardHandlerProps {
  sendKey: (key: string) => void
  sendRaw: (data: string) => void
  toggleModifier: (key: keyof ModifierStates) => void
  keyboardRef: React.RefObject<Keyboard | null>
}

export function useKeyboardHandler({
  sendKey,
  sendRaw,
  toggleModifier,
  keyboardRef,
}: UseKeyboardHandlerProps) {
  const sendKeyRef = useRef(sendKey)
  const sendRawRef = useRef(sendRaw)
  const toggleModifierRef = useRef(toggleModifier)

  // Keep refs updated
  sendKeyRef.current = sendKey
  sendRawRef.current = sendRaw
  toggleModifierRef.current = toggleModifier

  const handleKeyPress = useCallback((button: string) => {
    switch (button) {
      case '{enter}':
        sendRawRef.current(KEY_SEQUENCES.ENTER)
        break
      case '{bksp}':
        sendRawRef.current(KEY_SEQUENCES.BACKSPACE)
        break
      case '{space}':
        sendKeyRef.current(' ')
        break
      case '{shift}':
        toggleModifierRef.current('shift')
        if (keyboardRef.current) {
          const currentLayout = keyboardRef.current.options.layoutName
          if (currentLayout !== 'symbols') {
            keyboardRef.current.setOptions({
              layoutName: currentLayout === 'shift' ? 'default' : 'shift',
            })
          }
        }
        break
      case '{sym}':
        keyboardRef.current?.setOptions({ layoutName: 'symbols' })
        break
      case '{abc}':
        keyboardRef.current?.setOptions({ layoutName: 'default' })
        break
      default:
        sendKeyRef.current(button)
        break
    }

    // Haptic feedback
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(10)
    }
  }, [keyboardRef])

  return handleKeyPress
}
