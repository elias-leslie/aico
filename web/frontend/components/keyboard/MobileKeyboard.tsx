'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import type { ConnectionStatus } from '../ATerm'
import { ControlBar } from './ControlBar'
import { moveComposeCaret } from './composeNavigation'
import { FullKeyboard } from './FullKeyboard'
import type { ArrowDirection } from './keyMappings'
import { ModifierProvider } from './ModifierContext'
import { NativeKeyboardInput } from './NativeKeyboardInput'
import type {
  ATermInputHandler,
  KeyboardSizePreset,
  KeyboardSpacingPreset,
  MobileKeyboardMode,
} from './types'

const MINIMIZED_STORAGE_KEY = 'a-term-keyboard-minimized'
const RIBBON_COLLAPSED_STORAGE_KEY = 'a-term-native-ribbon-collapsed'

interface MobileKeyboardProps {
  onSend: ATermInputHandler
  sessionId: string | null | undefined
  storageScopeId?: string | null
  onCompose: (
    sessionId: string,
    text: string,
    action: 'insert' | 'send',
  ) => Promise<boolean>
  connectionStatus?: ConnectionStatus
  onReconnect?: () => void
  keyboardSize?: KeyboardSizePreset
  keyboardSpacing?: KeyboardSpacingPreset
  keyboardMode?: MobileKeyboardMode
  onVoice?: () => void
  voiceActive?: boolean
  activeMode?: string
}

export function MobileKeyboard({
  onSend,
  sessionId,
  storageScopeId,
  onCompose,
  connectionStatus,
  onReconnect,
  keyboardSize = 'medium',
  keyboardSpacing = 'normal',
  keyboardMode = 'custom',
  onVoice,
  voiceActive = false,
  activeMode,
}: MobileKeyboardProps) {
  const [ctrlActive, setCtrlActive] = useState(false)
  const [composeFocused, setComposeFocused] = useState(false)
  const [minimized, setMinimized] = useLocalStorageState(
    MINIMIZED_STORAGE_KEY,
    false,
  )
  const [ribbonCollapsed, setRibbonCollapsed] = useLocalStorageState(
    RIBBON_COLLAPSED_STORAGE_KEY,
    false,
  )
  const nativeInputRef = useRef<HTMLInputElement>(null)
  const isNativeMode = keyboardMode === 'native'

  const handleToggleMinimize = useCallback(() => {
    setMinimized(!minimized)
  }, [minimized, setMinimized])
  const handleToggleRibbon = useCallback(() => {
    setRibbonCollapsed((current) => !current)
  }, [setRibbonCollapsed])

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
  const focusNativeInput = useCallback(() => {
    nativeInputRef.current?.focus({ preventScroll: true })
  }, [])
  // The bar's keys no longer take focus (see `keepKeyboardOpen`), so the phone's
  // keyboard stays up on its own and there is nothing to re-focus afterwards.
  const handleRibbonSend = onSend
  const handleArrow = useCallback(
    (
      direction: ArrowDirection,
      modifiers: { shift: boolean; ctrl: boolean; alt: boolean },
    ) => {
      const input = nativeInputRef.current
      if (!composeFocused || !input || modifiers.ctrl || modifiers.alt)
        return false
      return moveComposeCaret(input, direction, modifiers.shift)
    },
    [composeFocused],
  )

  useEffect(() => {
    if (!isNativeMode || voiceActive || ribbonCollapsed) {
      return
    }

    const timer = window.setTimeout(() => {
      focusNativeInput()
    }, 60)

    return () => window.clearTimeout(timer)
  }, [focusNativeInput, isNativeMode, ribbonCollapsed, voiceActive])

  return (
    <ModifierProvider>
      <div
        className="flex shrink-0 flex-col"
        style={{
          paddingBottom: voiceActive ? 0 : 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {sessionId && !voiceActive && (
          <NativeKeyboardInput
            key={`${storageScopeId ?? ''}:${sessionId}`}
            sessionId={sessionId}
            storageScopeId={storageScopeId}
            connected={connectionStatus === 'connected'}
            onCommit={onCompose}
            onFocusChange={setComposeFocused}
            keyboardSize={keyboardSize}
            keyboardSpacing={keyboardSpacing}
            inputRef={nativeInputRef}
          />
        )}
        {isNativeMode && ribbonCollapsed ? (
          <div
            className="flex items-center justify-between gap-3 border-t px-3 py-2"
            style={{
              backgroundColor: 'var(--term-bg-surface)',
              borderColor: 'var(--term-border)',
            }}
          >
            <button
              type="button"
              onClick={handleToggleRibbon}
              className="rounded-md px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em]"
              style={{
                backgroundColor: 'var(--term-bg-elevated)',
                color: 'var(--term-text-primary)',
                border: '1px solid var(--term-border)',
              }}
            >
              Show ribbon
            </button>
            {onVoice && (
              <button
                type="button"
                onClick={onVoice}
                className="rounded-md px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em]"
                style={{
                  backgroundColor: 'var(--term-bg-elevated)',
                  color: 'var(--term-text-muted)',
                  border: '1px solid var(--term-border)',
                }}
              >
                Mic
              </button>
            )}
          </div>
        ) : (
          <ControlBar
            onSend={handleRibbonSend}
            onArrow={handleArrow}
            ctrlActive={ctrlActive}
            onCtrlToggle={handleCtrlToggle}
            minimized={isNativeMode ? ribbonCollapsed : minimized}
            onToggleMinimize={
              isNativeMode ? handleToggleRibbon : handleToggleMinimize
            }
            onVoice={onVoice}
            voiceActive={voiceActive}
            activeMode={activeMode}
            connectionStatus={connectionStatus}
            onReconnect={onReconnect}
            keyboardSize={keyboardSize}
            keyboardSpacing={keyboardSpacing}
            collapseTarget={isNativeMode ? 'ribbon' : 'keyboard'}
          />
        )}

        {/* Full keyboard - hidden when minimized or voice is active */}
        {!isNativeMode && !minimized && !voiceActive && !composeFocused && (
          <FullKeyboard
            onSend={handleSend}
            keyboardSize={keyboardSize}
            keyboardSpacing={keyboardSpacing}
          />
        )}
      </div>
    </ModifierProvider>
  )
}
