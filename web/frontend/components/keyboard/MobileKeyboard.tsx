'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import type { ConnectionStatus } from '../ATerm'
import { ControlBar } from './ControlBar'
import { moveComposeCaret } from './composeNavigation'
import { FullKeyboard } from './FullKeyboard'
import type { ArrowDirection } from './keyMappings'
import { ModifierProvider } from './ModifierContext'
import { isComposePending, NativeKeyboardInput } from './NativeKeyboardInput'
import type {
  ATermInputHandler,
  KeyboardSizePreset,
  KeyboardSpacingPreset,
  MobileKeyboardMode,
} from './types'

const MINIMIZED_STORAGE_KEY = 'a-term-keyboard-minimized'

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
  const [nativeEditingOpen, setNativeEditingOpen] = useState(false)
  const [hasNativeDraft, setHasNativeDraft] = useState(false)
  const [minimized, setMinimized] = useLocalStorageState(
    MINIMIZED_STORAGE_KEY,
    false,
  )
  const nativeInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const lastSessionIdentityRef = useRef<string | null>(null)
  const viewportBeforeFocusRef = useRef<number | null>(null)
  const keyboardSeenRef = useRef(false)
  const isNativeMode = keyboardMode === 'native'
  const sessionIdentity = `${storageScopeId ?? ''}:${sessionId ?? ''}`

  const handleToggleMinimize = useCallback(() => {
    setMinimized(!minimized)
  }, [minimized, setMinimized])
  const dismissNativeEditing = useCallback(() => {
    if (isComposePending(storageScopeId, sessionId)) return false
    if (!nativeEditingOpen) return true
    nativeInputRef.current?.blur()
    flushSync(() => setNativeEditingOpen(false))
    return true
  }, [nativeEditingOpen, sessionId, storageScopeId])

  const handleToggleNativeEditing = useCallback(() => {
    if (nativeEditingOpen) {
      dismissNativeEditing()
      return
    }
    viewportBeforeFocusRef.current =
      window.visualViewport?.height ?? window.innerHeight
    keyboardSeenRef.current = false
    // iOS requires focus to remain in the same user gesture as the tap.
    flushSync(() => setNativeEditingOpen(true))
    nativeInputRef.current?.focus({ preventScroll: true })
  }, [nativeEditingOpen, dismissNativeEditing])

  // Wrapped onSend that handles CTRL modifier
  const handleSend = useCallback(
    (key: string) => {
      if (isComposePending(storageScopeId, sessionId)) return
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
    [ctrlActive, onSend, sessionId, storageScopeId],
  )

  const handleCtrlToggle = useCallback(() => {
    setCtrlActive((prev) => !prev)
  }, [])
  const handleNativeCtrlLetter = useCallback(
    (letter: string) => {
      if (!ctrlActive || isComposePending(storageScopeId, sessionId)) return
      onSend(String.fromCharCode(letter.toLowerCase().charCodeAt(0) - 96))
      setCtrlActive(false)
    },
    [ctrlActive, onSend, sessionId, storageScopeId],
  )
  const handleRibbonSend = useCallback(
    (key: string) => {
      if (!isComposePending(storageScopeId, sessionId)) onSend(key)
    },
    [onSend, sessionId, storageScopeId],
  )
  const handleVoice = useCallback(() => {
    if (!isComposePending(storageScopeId, sessionId)) onVoice?.()
  }, [onVoice, sessionId, storageScopeId])
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
    if (isNativeMode && !voiceActive) return
    nativeInputRef.current?.blur()
    setNativeEditingOpen(false)
  }, [isNativeMode, voiceActive])

  useEffect(() => {
    if (lastSessionIdentityRef.current === sessionIdentity) return
    lastSessionIdentityRef.current = sessionIdentity
    nativeInputRef.current?.blur()
    setNativeEditingOpen(false)
    setComposeFocused(false)
  }, [sessionIdentity])

  useEffect(() => {
    if (!isNativeMode || !nativeEditingOpen) return
    const viewport = window.visualViewport
    const before = viewportBeforeFocusRef.current
    if (!viewport || !before) return
    const handleViewportResize = () => {
      const shrink = before - viewport.height
      // A software keyboard takes a substantial part of the phone viewport;
      // small browser-chrome changes should not dismiss the editor.
      if (shrink > before * 0.2) keyboardSeenRef.current = true
      if (keyboardSeenRef.current && shrink < before * 0.08) {
        nativeInputRef.current?.blur()
        setNativeEditingOpen(false)
      }
    }
    viewport.addEventListener('resize', handleViewportResize)
    return () => viewport.removeEventListener('resize', handleViewportResize)
  }, [isNativeMode, nativeEditingOpen])

  return (
    <ModifierProvider>
      <div
        className="relative flex shrink-0 flex-col overflow-visible"
        style={{
          paddingBottom: voiceActive ? 0 : 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {isNativeMode && sessionId && !voiceActive && (
          <NativeKeyboardInput
            key={`${storageScopeId ?? ''}:${sessionId}`}
            sessionId={sessionId}
            storageScopeId={storageScopeId}
            connected={connectionStatus === 'connected'}
            onCommit={onCompose}
            onFocusChange={(focused) => {
              setComposeFocused(focused)
              if (!focused) setNativeEditingOpen(false)
            }}
            keyboardSize={keyboardSize}
            keyboardSpacing={keyboardSpacing}
            inputRef={nativeInputRef}
            mobileOverlay
            visible={nativeEditingOpen}
            onDraftPresenceChange={setHasNativeDraft}
            ctrlActive={ctrlActive}
            onCtrlLetter={handleNativeCtrlLetter}
            onCtrlCancel={() => setCtrlActive(false)}
          />
        )}
        <ControlBar
          onSend={handleRibbonSend}
          onArrow={handleArrow}
          onBeforeTerminalAction={() =>
            !isComposePending(storageScopeId, sessionId)
          }
          ctrlActive={ctrlActive}
          onCtrlToggle={handleCtrlToggle}
          minimized={isNativeMode ? !nativeEditingOpen : minimized}
          onToggleMinimize={
            isNativeMode ? handleToggleNativeEditing : handleToggleMinimize
          }
          onVoice={onVoice ? handleVoice : undefined}
          voiceActive={voiceActive}
          activeMode={activeMode}
          connectionStatus={connectionStatus}
          onReconnect={onReconnect}
          keyboardSize={keyboardSize}
          keyboardSpacing={keyboardSpacing}
          collapseTarget="keyboard"
          showShiftControl={isNativeMode}
          hasUnsentDraft={isNativeMode && hasNativeDraft}
          closeToolboxWhenMinimized={isNativeMode}
        />

        {/* Full keyboard - hidden when minimized or voice is active */}
        {!isNativeMode && !minimized && !voiceActive && (
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
