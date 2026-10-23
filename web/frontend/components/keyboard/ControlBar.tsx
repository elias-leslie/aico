'use client'

import { clsx } from 'clsx'
import { ChevronDown, ChevronUp, Mic, Move, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type ClaudeModelOption,
  getClaudeModelOptions,
} from '@/lib/utils/agent-hub-models'
import { KeyboardKey } from './KeyboardKey'
import {
  type ArrowDirection,
  arrowSequence,
  KEY_SEQUENCES,
} from './keyMappings'
import { useModifiers } from './ModifierContext'
import {
  KEY_ROW_METRICS,
  keepKeyboardOpen,
  remSize,
  type TerminalInputHandler,
} from './types'

interface ControlBarProps {
  onSend: TerminalInputHandler
  onArrow?: (
    direction: ArrowDirection,
    modifiers: { shift: boolean; ctrl: boolean; alt: boolean },
  ) => boolean
  // Modifiers
  ctrlActive?: boolean
  onCtrlToggle?: () => void
  // Keyboard minimize
  minimized?: boolean
  onToggleMinimize?: () => void
  // Voice input
  onVoice?: () => void
  voiceActive?: boolean
  // Active pane mode (show model picker when agent mode)
  activeMode?: string
  onBeforeTerminalAction?: () => boolean
}

export function ControlBar({
  onSend,
  onArrow,
  ctrlActive = false,
  onCtrlToggle,
  minimized = false,
  onToggleMinimize,
  onVoice,
  voiceActive = false,
  activeMode,
  onBeforeTerminalAction,
}: ControlBarProps) {
  const { modifiers, resetModifiers, toggleModifier } = useModifiers()
  const [showToolbox, setShowToolbox] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [modelOptions, setModelOptions] = useState<ClaudeModelOption[]>([])
  const pickerRef = useRef<HTMLDivElement>(null)
  const isClaudeMode = activeMode === 'claude-code'

  useEffect(() => {
    if (!isClaudeMode) {
      setShowModelPicker(false)
      setModelOptions([])
      return
    }

    let mounted = true
    void getClaudeModelOptions()
      .then((options) => {
        if (mounted) setModelOptions(options)
      })
      .catch((error) => {
        console.error('Failed to load Claude model options', error)
        if (mounted) setModelOptions([])
      })

    return () => {
      mounted = false
    }
  }, [isClaudeMode])

  // Close picker on outside tap
  useEffect(() => {
    if (!showModelPicker) return
    const handleTap = (e: MouseEvent | TouchEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false)
      }
    }
    document.addEventListener('mousedown', handleTap)
    document.addEventListener('touchstart', handleTap)
    return () => {
      document.removeEventListener('mousedown', handleTap)
      document.removeEventListener('touchstart', handleTap)
    }
  }, [showModelPicker])

  // Helper to clear modifiers after use
  const clearModifiers = useCallback(() => {
    if (ctrlActive && onCtrlToggle) onCtrlToggle()
    resetModifiers()
  }, [ctrlActive, onCtrlToggle, resetModifiers])

  const handleArrow = useCallback(
    (direction: ArrowDirection) => {
      const active = {
        shift: modifiers.shift !== 'off',
        ctrl: ctrlActive || modifiers.ctrl !== 'off',
        alt: modifiers.alt !== 'off',
      }
      if (!onArrow?.(direction, active)) {
        if (onBeforeTerminalAction?.() === false) return
        onSend(arrowSequence(direction, active))
      }
      clearModifiers()
    },
    [
      clearModifiers,
      ctrlActive,
      modifiers,
      onArrow,
      onBeforeTerminalAction,
      onSend,
    ],
  )

  // Special key handlers
  const handleEsc = useCallback(() => {
    if (onBeforeTerminalAction?.() === false) return
    onSend(KEY_SEQUENCES.ESC)
    clearModifiers()
  }, [onBeforeTerminalAction, onSend, clearModifiers])

  const handleTab = useCallback(() => {
    if (onBeforeTerminalAction?.() === false) return
    onSend(
      modifiers.shift !== 'off' ? KEY_SEQUENCES.SHIFT_TAB : KEY_SEQUENCES.TAB,
    )
    clearModifiers()
  }, [onBeforeTerminalAction, onSend, modifiers.shift, clearModifiers])

  const handleEnter = useCallback(() => {
    if (onBeforeTerminalAction?.() === false) return
    onSend(KEY_SEQUENCES.ENTER)
    clearModifiers()
  }, [onBeforeTerminalAction, onSend, clearModifiers])

  const handleModelSelect = useCallback(
    (command: string) => {
      navigator.vibrate?.(10)
      if (onBeforeTerminalAction?.() === false) return
      onSend(command)
      setShowModelPicker(false)
    },
    [onBeforeTerminalAction, onSend],
  )

  // Sized in rem so the phone's text-scaling setting scales the bar with the
  // keyboard it sits against.
  const controlButtonSize = remSize(KEY_ROW_METRICS.buttonSize)
  const arrowButtonSize = remSize(KEY_ROW_METRICS.arrowSize)
  const iconSize = remSize(KEY_ROW_METRICS.iconSize)
  const keyStyle = { height: controlButtonSize, minWidth: remSize(32) }
  const arrowStyle = { flex: '1 1 0', height: arrowButtonSize, minWidth: 0 }
  const shiftState = modifiers.shift

  return (
    <div
      className="flex flex-col"
      style={{
        gap: KEY_ROW_METRICS.rowGap,
        padding: `0 ${KEY_ROW_METRICS.paddingX}px ${KEY_ROW_METRICS.paddingY}px`,
      }}
    >
      {showToolbox && (
        <div
          id="control-bar-arrows"
          aria-label="Arrow keys"
          className="flex items-center justify-center"
          style={{ gap: KEY_ROW_METRICS.arrowGroupGap }}
        >
          <KeyboardKey
            label="←"
            onPress={() => handleArrow('left')}
            className="text-xl"
            style={arrowStyle}
          />
          <KeyboardKey
            label="↑"
            onPress={() => handleArrow('up')}
            className="text-xl"
            style={arrowStyle}
          />
          <KeyboardKey
            label="↓"
            onPress={() => handleArrow('down')}
            className="text-xl"
            style={arrowStyle}
          />
          <KeyboardKey
            label="→"
            onPress={() => handleArrow('right')}
            className="text-xl"
            style={arrowStyle}
          />
          <KeyboardKey
            label="Enter"
            onPress={handleEnter}
            className="text-sm"
            style={arrowStyle}
          />
        </div>
      )}

      {/* Persistent utility row */}
      <div
        className="flex min-w-0 items-center justify-between"
        style={{ gap: KEY_ROW_METRICS.keyGap }}
      >
        {/* Keyboard toggle — far left */}
        {onToggleMinimize && (
          <button
            type="button"
            onPointerDown={keepKeyboardOpen}
            onClick={onToggleMinimize}
            className="lantern-key shrink-0"
            style={keyStyle}
            aria-label={minimized ? 'Show keyboard' : 'Hide keyboard'}
          >
            {minimized ? (
              <ChevronUp style={{ width: iconSize, height: iconSize }} />
            ) : (
              <ChevronDown style={{ width: iconSize, height: iconSize }} />
            )}
          </button>
        )}

        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={handleTab}
          className="lantern-key flex-1"
          style={keyStyle}
          aria-label="Tab"
        >
          TAB
        </button>

        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={() => toggleModifier('shift')}
          aria-label="Shift"
          aria-pressed={shiftState !== 'off'}
          title="Shift for next key; double tap to lock"
          className={clsx(
            'lantern-key flex-1 text-base!',
            shiftState === 'locked' && 'locked',
          )}
          style={keyStyle}
        >
          ⇧
        </button>

        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={() => {
            navigator.vibrate?.(10)
            onVoice?.()
          }}
          disabled={!onVoice}
          className="lantern-key flex-1"
          style={keyStyle}
          aria-label={onVoice ? 'Voice input' : 'Voice input unavailable'}
          aria-pressed={voiceActive}
          title={onVoice ? 'Voice input' : 'Voice input unavailable'}
        >
          <Mic
            style={{ width: iconSize, height: iconSize }}
            strokeWidth={1.7}
          />
        </button>

        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={handleEsc}
          className="lantern-key flex-1"
          style={keyStyle}
        >
          ESC
        </button>

        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={onCtrlToggle}
          aria-pressed={ctrlActive}
          className="lantern-key flex-1"
          style={keyStyle}
        >
          CTRL
        </button>

        {/* Model picker — only relevant for Claude sessions */}
        {isClaudeMode && (
          <div className="relative min-w-0 flex-1" ref={pickerRef}>
            <button
              type="button"
              onPointerDown={keepKeyboardOpen}
              onClick={() => setShowModelPicker((p) => !p)}
              className="lantern-key w-full"
              style={keyStyle}
              aria-label="Switch Claude model"
              aria-expanded={showModelPicker}
            >
              <Sparkles
                style={{ width: remSize(16), height: remSize(16) }}
                strokeWidth={1.7}
              />
            </button>

            {showModelPicker && (
              <div
                className="lantern-sheet lantern-enter absolute right-0 bottom-full z-50 mb-1.5 min-w-[160px] rounded-xl p-1.5"
                role="menu"
              >
                {modelOptions.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role="menuitem"
                    onPointerDown={keepKeyboardOpen}
                    onClick={() => handleModelSelect(opt.command)}
                    className="lantern-menu-item"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={() => setShowToolbox((open) => !open)}
          aria-label={showToolbox ? 'Hide arrow keys' : 'Show arrow keys'}
          aria-expanded={showToolbox}
          aria-controls="control-bar-arrows"
          className="lantern-key shrink-0"
          style={keyStyle}
        >
          <Move
            style={{ width: iconSize, height: iconSize }}
            strokeWidth={1.7}
          />
        </button>
      </div>
    </div>
  )
}
