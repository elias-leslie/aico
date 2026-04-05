'use client'

import { useCallback, useState } from 'react'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import type { ConnectionStatus } from '../ATerm'
import { ControlBar } from './ControlBar'
import { FullKeyboard } from './FullKeyboard'
import { ModifierProvider } from './ModifierContext'
import type { KeyboardSizePreset, ATermInputHandler } from './types'

const MINIMIZED_STORAGE_KEY = 'aterm-keyboard-minimized'

interface MobileKeyboardProps {
  onSend: ATermInputHandler
  connectionStatus?: ConnectionStatus
  onReconnect?: () => void
  keyboardSize?: KeyboardSizePreset
  onVoice?: () => void
  voiceActive?: boolean
  activeMode?: string
}

export function MobileKeyboard({
  onSend,
  connectionStatus,
  onReconnect,
  keyboardSize = 'medium',
  onVoice,
  voiceActive = false,
  activeMode,
}: MobileKeyboardProps) {
  const [ctrlActive, setCtrlActive] = useState(false)
  const [minimized, setMinimized] = useLocalStorageState(
    MINIMIZED_STORAGE_KEY,
    false,
  )

  const handleToggleMinimize = useCallback(() => {
    setMinimized(!minimized)
  }, [minimized, setMinimized])

  // Wrapped onSend that handles CTRL modifier
  const handleSend = useCallback(
    (key: string) => {
      if (ctrlActive && key.length === 1) {
        // Send Ctrl+key sequence (ASCII control codes)
        const char = key.toLowerCase()
        if (char >= 'a' && char <= 'z') {
          const ctrlCode = char.charCodeAt(0) - 96 // a=1, b=2, ..., z=26
          onSend(String.fromCharCode(ctrlCode))
          setCtrlActive(false)
          return
        }
      }
      onSend(key)
    },
    [ctrlActive, onSend],
  )

  const handleCtrlToggle = useCallback(() => {
    setCtrlActive((prev) => !prev)
  }, [])

  return (
    <ModifierProvider>
      <div className="flex flex-col">
        {/* Control bar with arrows and special keys - always visible */}
        <ControlBar
          onSend={onSend}
          ctrlActive={ctrlActive}
          onCtrlToggle={handleCtrlToggle}
          minimized={minimized}
          onToggleMinimize={handleToggleMinimize}
          onVoice={onVoice}
          voiceActive={voiceActive}
          activeMode={activeMode}
          connectionStatus={connectionStatus}
          onReconnect={onReconnect}
        />
        {/* Full keyboard - hidden when minimized or voice is active */}
        {!minimized && !voiceActive && (
          <FullKeyboard onSend={handleSend} keyboardSize={keyboardSize} />
        )}
      </div>
    </ModifierProvider>
  )
}
