'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionStatus } from '../ATerm'
import { ControlBar } from './ControlBar'
import { moveComposeCaret } from './composeNavigation'
import type { ArrowDirection } from './keyMappings'
import { ModifierProvider } from './ModifierContext'
import { isComposePending, NativeKeyboardInput } from './NativeKeyboardInput'
import type { ATermInputHandler } from './types'

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
  onVoice?: () => void
  voiceActive?: boolean
  activeMode?: string
}

/**
 * The phone's input area: the compose box above the key row. Typing uses the
 * phone's own keyboard; the key row's first button shows or hides it.
 */
export function MobileKeyboard({
  onSend,
  sessionId,
  storageScopeId,
  onCompose,
  connectionStatus,
  onReconnect,
  onVoice,
  voiceActive = false,
  activeMode,
}: MobileKeyboardProps) {
  const [ctrlActive, setCtrlActive] = useState(false)
  const [composeFocused, setComposeFocused] = useState(false)
  const composeRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const lastSessionIdentityRef = useRef<string | null>(null)
  const viewportBeforeFocusRef = useRef<number | null>(null)
  const keyboardSeenRef = useRef(false)
  const sessionIdentity = `${storageScopeId ?? ''}:${sessionId ?? ''}`

  const handleToggleKeyboard = useCallback(() => {
    if (composeFocused) {
      if (isComposePending(storageScopeId, sessionId)) return
      composeRef.current?.blur()
      return
    }
    viewportBeforeFocusRef.current =
      window.visualViewport?.height ?? window.innerHeight
    keyboardSeenRef.current = false
    // iOS requires focus to remain in the same user gesture as the tap.
    composeRef.current?.focus({ preventScroll: true })
  }, [composeFocused, sessionId, storageScopeId])

  const handleCtrlToggle = useCallback(() => {
    setCtrlActive((prev) => !prev)
  }, [])
  const handleCtrlLetter = useCallback(
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
      const input = composeRef.current
      if (!composeFocused || !input || modifiers.ctrl || modifiers.alt)
        return false
      return moveComposeCaret(input, direction, modifiers.shift)
    },
    [composeFocused],
  )

  useEffect(() => {
    if (voiceActive) composeRef.current?.blur()
  }, [voiceActive])

  useEffect(() => {
    if (lastSessionIdentityRef.current === sessionIdentity) return
    lastSessionIdentityRef.current = sessionIdentity
    composeRef.current?.blur()
    setComposeFocused(false)
  }, [sessionIdentity])

  // Closing the phone's keyboard (back gesture, keyboard's own button) leaves
  // the compose box focused; blur it so the key row offers to show it again.
  useEffect(() => {
    if (!composeFocused) return
    const viewport = window.visualViewport
    const before =
      viewportBeforeFocusRef.current ?? viewport?.height ?? window.innerHeight
    if (!viewport || !before) return
    const handleViewportResize = () => {
      const shrink = before - viewport.height
      // A software keyboard takes a substantial part of the phone viewport;
      // small browser-chrome changes should not count as closing it.
      if (shrink > before * 0.2) keyboardSeenRef.current = true
      if (keyboardSeenRef.current && shrink < before * 0.08) {
        composeRef.current?.blur()
      }
    }
    viewport.addEventListener('resize', handleViewportResize)
    return () => viewport.removeEventListener('resize', handleViewportResize)
  }, [composeFocused])

  return (
    <ModifierProvider>
      <div
        className="relative flex shrink-0 flex-col overflow-visible"
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
            onFocusChange={(focused) => {
              setComposeFocused(focused)
              if (focused && viewportBeforeFocusRef.current === null) {
                viewportBeforeFocusRef.current =
                  window.visualViewport?.height ?? window.innerHeight
              }
              if (!focused) {
                viewportBeforeFocusRef.current = null
                keyboardSeenRef.current = false
              }
            }}
            inputRef={composeRef}
            mobileOverlay
            ctrlActive={ctrlActive}
            onCtrlLetter={handleCtrlLetter}
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
          minimized={!composeFocused}
          onToggleMinimize={handleToggleKeyboard}
          onVoice={onVoice ? handleVoice : undefined}
          voiceActive={voiceActive}
          activeMode={activeMode}
          connectionStatus={connectionStatus}
          onReconnect={onReconnect}
        />
      </div>
    </ModifierProvider>
  )
}
