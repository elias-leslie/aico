'use client'

import { ChevronDown, ChevronUp, Mic, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionStatus } from '@/components/a-term.types'
import {
  type ClaudeModelOption,
  getClaudeModelOptions,
} from '@/lib/utils/agent-hub-models'
import {
  getMobileATermBannerState,
  isReconnectableStatus,
} from '@/lib/utils/mobile-a-term-status'
import { KeyboardKey } from './KeyboardKey'
import {
  type ArrowDirection,
  arrowSequence,
  KEY_SEQUENCES,
} from './keyMappings'
import { useModifiers } from './ModifierContext'
import {
  type ATermInputHandler,
  CONTROL_BAR_ARROW_SIZES,
  CONTROL_BAR_BUTTON_SIZES,
  KEYBOARD_SPACING_METRICS,
  type KeyboardSizePreset,
  type KeyboardSpacingPreset,
  keepKeyboardOpen,
  remSize,
} from './types'

interface ControlBarProps {
  onSend: ATermInputHandler
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
  connectionStatus?: ConnectionStatus
  onReconnect?: () => void
  keyboardSize?: KeyboardSizePreset
  keyboardSpacing?: KeyboardSpacingPreset
  collapseTarget?: 'keyboard' | 'ribbon'
  showShiftControl?: boolean
  hasUnsentDraft?: boolean
  closeToolboxWhenMinimized?: boolean
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
  connectionStatus,
  onReconnect,
  keyboardSize = 'medium',
  keyboardSpacing = 'normal',
  collapseTarget = 'keyboard',
  showShiftControl = false,
  hasUnsentDraft = false,
  closeToolboxWhenMinimized = false,
  onBeforeTerminalAction,
}: ControlBarProps) {
  const { modifiers, resetModifiers, toggleModifier } = useModifiers()
  const [showToolbox, setShowToolbox] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [modelOptions, setModelOptions] = useState<ClaudeModelOption[]>([])
  const pickerRef = useRef<HTMLDivElement>(null)
  const isClaudeMode = activeMode === 'claude'

  useEffect(() => {
    if (minimized && closeToolboxWhenMinimized) setShowToolbox(false)
  }, [closeToolboxWhenMinimized, minimized])

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

  const handleModelSelect = useCallback(
    (command: string) => {
      navigator.vibrate?.(10)
      if (onBeforeTerminalAction?.() === false) return
      onSend(command)
      setShowModelPicker(false)
    },
    [onBeforeTerminalAction, onSend],
  )

  const btnStyle = {
    backgroundColor: 'var(--term-bg-elevated)',
    color: 'var(--term-text-muted)',
    border: '1px solid var(--term-border)',
  }
  const spacing = KEYBOARD_SPACING_METRICS[keyboardSpacing]
  // Sized in rem so the phone's text-scaling setting scales the bar with the
  // keyboard it sits against.
  const controlButtonSize = remSize(CONTROL_BAR_BUTTON_SIZES[keyboardSize])
  const arrowButtonSize = remSize(CONTROL_BAR_ARROW_SIZES[keyboardSize])
  const iconSize = remSize(
    keyboardSize === 'small' ? 18 : keyboardSize === 'large' ? 22 : 20,
  )
  const topRowButtonStyle = {
    height: controlButtonSize,
    minWidth: remSize(showShiftControl ? 32 : 36),
    borderRadius: spacing.keyRadius,
  }

  const bannerState = getMobileATermBannerState({
    connectionStatus,
    activeMode,
    voiceActive,
    minimized,
    canReconnect:
      isReconnectableStatus(connectionStatus) && onReconnect !== undefined,
  })

  const bannerToneStyles = {
    neutral: {
      borderColor: 'var(--term-border)',
      backgroundColor: 'var(--term-surface-soft)',
      dotColor: 'var(--term-text-muted)',
      labelColor: 'var(--term-text-primary)',
    },
    success: {
      borderColor: 'color-mix(in srgb, var(--term-success) 35%, transparent)',
      backgroundColor:
        'color-mix(in srgb, var(--term-success) 12%, transparent)',
      dotColor: 'var(--term-success)',
      labelColor: 'var(--term-text-primary)',
    },
    warning: {
      borderColor: 'color-mix(in srgb, var(--term-warning) 35%, transparent)',
      backgroundColor:
        'color-mix(in srgb, var(--term-warning) 12%, transparent)',
      dotColor: 'var(--term-warning)',
      labelColor: 'var(--term-text-primary)',
    },
    danger: {
      borderColor: 'var(--term-danger-border)',
      backgroundColor: 'var(--term-danger-soft)',
      dotColor: 'var(--term-error)',
      labelColor: 'var(--term-text-primary)',
    },
  }[bannerState.tone]

  return (
    <div
      className="flex flex-col"
      style={{
        backgroundColor: 'var(--term-bg-surface)',
        borderTop: '1px solid var(--term-border)',
        gap: spacing.controlRowGap,
        padding: `${spacing.controlPaddingY}px ${spacing.controlPaddingX}px`,
      }}
    >
      {showToolbox && (
        <div
          id="control-bar-arrows"
          aria-label="Arrow keys"
          className="flex items-center justify-center"
          style={{ gap: spacing.arrowGroupGap }}
        >
          <KeyboardKey
            label="←"
            onPress={() => handleArrow('left')}
            className="text-xl"
            style={{
              flex: '1 1 0',
              height: arrowButtonSize,
              minWidth: 0,
            }}
          />
          <KeyboardKey
            label="↑"
            onPress={() => handleArrow('up')}
            className="text-xl"
            style={{
              flex: '1 1 0',
              height: arrowButtonSize,
              minWidth: 0,
            }}
          />
          <KeyboardKey
            label="↓"
            onPress={() => handleArrow('down')}
            className="text-xl"
            style={{
              flex: '1 1 0',
              height: arrowButtonSize,
              minWidth: 0,
            }}
          />
          <KeyboardKey
            label="→"
            onPress={() => handleArrow('right')}
            className="text-xl"
            style={{
              flex: '1 1 0',
              height: arrowButtonSize,
              minWidth: 0,
            }}
          />
        </div>
      )}

      {/* Persistent utility row */}
      <div
        className="flex min-w-0 items-center justify-between"
        style={{ gap: spacing.keyGap }}
      >
        {/* Keyboard toggle — far left */}
        {onToggleMinimize && (
          <button
            type="button"
            onPointerDown={keepKeyboardOpen}
            onClick={onToggleMinimize}
            className="relative flex shrink-0 items-center justify-center transition-all duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{
              ...topRowButtonStyle,
              backgroundColor: minimized
                ? 'var(--term-accent)'
                : 'var(--term-bg-elevated)',
              color: minimized
                ? 'var(--term-accent-foreground)'
                : 'var(--term-text-muted)',
              border: `1px solid ${minimized ? 'var(--term-accent)' : 'var(--term-border)'}`,
              boxShadow: minimized ? '0 0 8px var(--term-accent-glow)' : 'none',
            }}
            aria-label={`${minimized ? 'Show' : 'Hide'} ${collapseTarget}${hasUnsentDraft ? ', unsent draft' : ''}`}
          >
            {minimized ? (
              <ChevronUp
                className="shrink-0"
                style={{ width: iconSize, height: iconSize }}
              />
            ) : (
              <ChevronDown
                className="shrink-0"
                style={{ width: iconSize, height: iconSize }}
              />
            )}
            {hasUnsentDraft && (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 size-1.5 rounded-full"
                style={{ backgroundColor: 'var(--term-accent)' }}
              />
            )}
          </button>
        )}

        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={handleTab}
          className="min-w-0 flex-1 text-xs font-medium transition-all duration-150 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{
            ...btnStyle,
            ...topRowButtonStyle,
          }}
          aria-label="Tab"
        >
          TAB
        </button>

        {showShiftControl && (
          <button
            type="button"
            onPointerDown={keepKeyboardOpen}
            onClick={() => toggleModifier('shift')}
            aria-label="Shift"
            aria-pressed={modifiers.shift !== 'off'}
            title="Shift for next key; double tap to lock"
            className="min-w-0 flex-1 text-lg font-medium transition-all duration-150 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{
              ...topRowButtonStyle,
              backgroundColor:
                modifiers.shift !== 'off'
                  ? 'var(--term-accent)'
                  : 'var(--term-bg-elevated)',
              color:
                modifiers.shift !== 'off'
                  ? 'var(--term-accent-foreground)'
                  : 'var(--term-text-muted)',
              border: `1px solid ${modifiers.shift !== 'off' ? 'var(--term-accent)' : 'var(--term-border)'}`,
            }}
          >
            ⇧
          </button>
        )}

        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={() => {
            navigator.vibrate?.(10)
            onVoice?.()
          }}
          disabled={!onVoice}
          className="flex min-w-0 flex-1 items-center justify-center transition-all duration-150 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
          style={{ ...btnStyle, ...topRowButtonStyle }}
          aria-label={onVoice ? 'Voice input' : 'Voice input unavailable'}
          aria-pressed={voiceActive}
          title={onVoice ? 'Voice input' : 'Voice input unavailable'}
        >
          <Mic
            className="shrink-0"
            style={{ width: iconSize, height: iconSize }}
          />
        </button>

        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={handleEsc}
          className="min-w-0 flex-1 text-xs font-medium transition-all duration-150 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ ...btnStyle, ...topRowButtonStyle }}
        >
          ESC
        </button>

        <button
          type="button"
          onPointerDown={keepKeyboardOpen}
          onClick={onCtrlToggle}
          aria-pressed={ctrlActive}
          className="min-w-0 flex-1 text-xs font-medium transition-all duration-150 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{
            ...topRowButtonStyle,
            backgroundColor: ctrlActive
              ? 'var(--term-accent)'
              : 'var(--term-bg-elevated)',
            color: ctrlActive
              ? 'var(--term-accent-foreground)'
              : 'var(--term-text-muted)',
            border: `1px solid ${ctrlActive ? 'var(--term-accent)' : 'var(--term-border)'}`,
            boxShadow: ctrlActive ? '0 0 8px var(--term-accent-glow)' : 'none',
          }}
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
              className="flex w-full items-center justify-center transition-all duration-150 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={
                showModelPicker
                  ? {
                      ...topRowButtonStyle,
                      backgroundColor: 'var(--term-accent-soft)',
                      color: 'var(--term-accent)',
                      border: '1px solid var(--term-accent)',
                    }
                  : {
                      ...btnStyle,
                      ...topRowButtonStyle,
                    }
              }
              aria-label="Switch Claude model"
              aria-expanded={showModelPicker}
            >
              <Sparkles
                className="shrink-0"
                style={{
                  width: remSize(keyboardSize === 'small' ? 14 : 16),
                  height: remSize(keyboardSize === 'small' ? 14 : 16),
                }}
              />
            </button>

            {/* Dropdown */}
            {showModelPicker && (
              <div
                className="absolute bottom-full mb-1 right-0 rounded-lg overflow-hidden"
                style={{
                  backgroundColor: 'var(--term-bg-elevated)',
                  border: '1px solid var(--term-border-active)',
                  boxShadow: 'var(--term-shadow-dropdown)',
                  minWidth: 140,
                  zIndex: 50,
                }}
              >
                {modelOptions.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onPointerDown={keepKeyboardOpen}
                    onClick={() => handleModelSelect(opt.command)}
                    className="w-full text-left px-4 py-3 text-sm font-medium transition-colors duration-100"
                    style={{
                      color: 'var(--term-text-primary)',
                      backgroundColor: 'transparent',
                      borderBottom: '1px solid var(--term-border)',
                      fontFamily: '"JetBrains Mono", monospace',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor =
                        'rgba(0, 255, 159, 0.1)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent'
                    }}
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
          className="flex shrink-0 items-center justify-center transition-all duration-150 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{
            ...topRowButtonStyle,
            backgroundColor: showToolbox
              ? 'var(--term-accent-soft)'
              : 'var(--term-bg-elevated)',
            color: showToolbox
              ? 'var(--term-accent)'
              : 'var(--term-text-muted)',
            border: `1px solid ${showToolbox ? 'var(--term-accent)' : 'var(--term-border)'}`,
          }}
        >
          {showToolbox ? (
            <ChevronDown style={{ width: iconSize, height: iconSize }} />
          ) : (
            <ChevronUp style={{ width: iconSize, height: iconSize }} />
          )}
        </button>
      </div>

      {/* Status banner — only shown for error/disconnect states that need
          user action. Connected/minimized/voice status is in the header badge. */}
      {(bannerState.tone === 'danger' || bannerState.tone === 'warning') && (
        <div className="flex items-center gap-2 px-1">
          <div
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5 py-2"
            style={{
              borderColor: bannerToneStyles.borderColor,
              backgroundColor: bannerToneStyles.backgroundColor,
            }}
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: bannerToneStyles.dotColor }}
            />
            <span
              className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em]"
              style={{ color: bannerToneStyles.labelColor }}
            >
              {bannerState.label}
            </span>
            {bannerState.detail && (
              <span
                className="min-w-0 truncate text-[11px]"
                style={{ color: 'var(--term-text-muted)' }}
              >
                {bannerState.detail}
              </span>
            )}
          </div>

          {bannerState.actionLabel && onReconnect && (
            <button
              type="button"
              onPointerDown={keepKeyboardOpen}
              onClick={onReconnect}
              className="shrink-0 rounded-md border px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] transition-all duration-150 active:scale-95"
              style={{
                borderColor: 'var(--term-danger-border)',
                backgroundColor: 'var(--term-danger-soft)',
                color: 'var(--term-text-primary)',
              }}
            >
              {bannerState.actionLabel}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
