'use client'

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Eraser,
  Keyboard,
  KeyboardOff,
} from 'lucide-react'
import type { ReactNode } from 'react'
import {
  type ArrowDirection,
  arrowSequence,
  CLEAR_PROMPT,
  KEY_SEQUENCES,
} from './keyMappings'
import {
  KEY_ROW_METRICS,
  keepKeyboardOpen,
  remSize,
  type TerminalInputHandler,
} from './types'

interface ControlBarProps {
  /** Sends a key to the session (and ends a sticky Ctrl). */
  onSend: TerminalInputHandler
  ctrlActive: boolean
  onCtrlToggle: () => void
  keyboardOpen: boolean
  onToggleKeyboard: () => void
}

const ARROWS: Array<{
  direction: ArrowDirection
  label: string
  icon: typeof ArrowUp
}> = [
  { direction: 'left', label: 'Left', icon: ArrowLeft },
  { direction: 'up', label: 'Up', icon: ArrowUp },
  { direction: 'down', label: 'Down', icon: ArrowDown },
  { direction: 'right', label: 'Right', icon: ArrowRight },
]

/**
 * The slim key row above the phone's keyboard: the keys a phone keyboard
 * lacks. Typing itself goes straight into the session.
 */
export function ControlBar({
  onSend,
  ctrlActive,
  onCtrlToggle,
  keyboardOpen,
  onToggleKeyboard,
}: ControlBarProps) {
  // Sized in rem so the phone's text-scaling setting scales the bar with the
  // keyboard it sits against.
  const iconSize = remSize(KEY_ROW_METRICS.iconSize)
  const icon = { width: iconSize, height: iconSize, strokeWidth: 1.7 }
  const key = (
    label: string,
    content: ReactNode,
    onPress: () => void,
    extra: { pressed?: boolean; title?: string } = {},
  ) => (
    <button
      key={label}
      type="button"
      onPointerDown={keepKeyboardOpen}
      onClick={() => {
        navigator.vibrate?.(10)
        onPress()
      }}
      aria-label={label}
      aria-pressed={extra.pressed}
      title={extra.title ?? label}
      className="lantern-key flex-1"
      style={{ height: remSize(KEY_ROW_METRICS.buttonSize) }}
    >
      {content}
    </button>
  )

  return (
    <div
      className="flex min-w-0 items-center"
      style={{
        gap: KEY_ROW_METRICS.keyGap,
        padding: `0 ${KEY_ROW_METRICS.paddingX}px ${KEY_ROW_METRICS.paddingY}px`,
      }}
    >
      {key(
        keyboardOpen ? 'Hide keyboard' : 'Show keyboard',
        keyboardOpen ? <KeyboardOff {...icon} /> : <Keyboard {...icon} />,
        onToggleKeyboard,
      )}
      {key('Esc', 'ESC', () => onSend(KEY_SEQUENCES.ESC))}
      {key('Tab', 'TAB', () => onSend(KEY_SEQUENCES.TAB))}
      {key('Ctrl', 'CTRL', onCtrlToggle, {
        pressed: ctrlActive,
        title: 'Ctrl for the next key',
      })}
      {ARROWS.map(({ direction, label, icon: Icon }) =>
        key(label, <Icon {...icon} />, () =>
          onSend(arrowSequence(direction, { ctrl: ctrlActive })),
        ),
      )}
      {key('Enter', <CornerDownLeft {...icon} />, () =>
        onSend(KEY_SEQUENCES.ENTER),
      )}
      {key('Clear prompt', <Eraser {...icon} />, () => onSend(CLEAR_PROMPT), {
        title: 'Clear the prompt',
      })}
    </div>
  )
}
