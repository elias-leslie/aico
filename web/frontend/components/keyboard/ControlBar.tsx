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
import { KEY_SEQUENCES } from './keyMappings'
import { useModifiers } from './ModifierContext'
import {
  type ATermInputHandler,
  CONTROL_BAR_ARROW_SIZES,
  CONTROL_BAR_BUTTON_SIZES,
  KEYBOARD_SPACING_METRICS,
  type KeyboardSizePreset,
  type KeyboardSpacingPreset,
} from './types'

interface ControlBarProps {
  onSend: ATermInputHandler
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
}

export function ControlBar({
  onSend,
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
}: ControlBarProps) {
  const { resetModifiers } = useModifiers()
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [modelOptions, setModelOptions] = useState<ClaudeModelOption[]>([])
  const pickerRef = useRef<HTMLDivElement>(null)
  const isClaudeMode = activeMode === 'claude'

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

  // Arrow key handlers
  const handleArrowLeft = useCallback(
    () => onSend(KEY_SEQUENCES.ARROW_LEFT),
    [onSend],
  )
  const handleArrowUp = useCallback(
    () => onSend(KEY_SEQUENCES.ARROW_UP),
    [onSend],
  )
  const handleArrowDown = useCallback(
    () => onSend(KEY_SEQUENCES.ARROW_DOWN),
    [onSend],
  )
  const handleArrowRight = useCallback(
    () => onSend(KEY_SEQUENCES.ARROW_RIGHT),
    [onSend],
  )

  // Special key handlers
  const handleEsc = useCallback(() => {
    onSend(KEY_SEQUENCES.ESC)
    clearModifiers()
  }, [onSend, clearModifiers])

  const handleShiftTab = useCallback(() => {
    onSend('\x1b[Z') // Shift+Tab (backtab)
    clearModifiers()
  }, [onSend, clearModifiers])

  const handleModelSelect = useCallback(
    (command: string) => {
      navigator.vibrate?.(10)
      onSend(command)
      setShowModelPicker(false)
    },
    [onSend],
  )

  const btnStyle = {
    backgroundColor: 'var(--term-bg-elevated)',
    color: 'var(--term-text-muted)',
    border: '1px solid var(--term-border)',
  }
  const spacing = KEYBOARD_SPACING_METRICS[keyboardSpacing]
  const controlButtonSize = CONTROL_BAR_BUTTON_SIZES[keyboardSize]
  const arrowButtonSize = CONTROL_BAR_ARROW_SIZES[keyboardSize]
  const smallKeySize = Math.max(36, controlButtonSize - 4)
  const iconSize =
    keyboardSize === 'small' ? 18 : keyboardSize === 'large' ? 22 : 20
  const topRowButtonStyle = {
    height: controlButtonSize,
    minWidth: controlButtonSize,
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
      {/* Row 1: [▲/▼] [TAB] [⇧TAB]  ·····  [MODEL?] [MIC] */}
      <div className="flex items-center" style={{ gap: spacing.keyGap + 2 }}>
        {/* Keyboard toggle — far left */}
        {onToggleMinimize && (
          <button
            type="button"
            onClick={onToggleMinimize}
            className="flex items-center justify-center transition-all duration-150"
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
            title={
              minimized ? `Show ${collapseTarget}` : `Hide ${collapseTarget}`
            }
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
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            onSend('\t')
            clearModifiers()
          }}
          className="px-3 text-xs font-medium transition-all duration-150 active:scale-95"
          style={{
            ...btnStyle,
            ...topRowButtonStyle,
          }}
          title="Tab"
        >
          TAB
        </button>

        {/* Shift+Tab */}
        <button
          type="button"
          onClick={handleShiftTab}
          className="px-3 text-xs font-medium transition-all duration-150 active:scale-95"
          style={{
            ...btnStyle,
            ...topRowButtonStyle,
          }}
          title="Shift+Tab (backtab)"
        >
          ⇧TAB
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Model picker — only relevant for Claude sessions */}
        {isClaudeMode && (
          <div className="relative" ref={pickerRef}>
            <button
              type="button"
              onClick={() => setShowModelPicker((p) => !p)}
              className="flex items-center gap-1.5 px-3 text-xs font-medium transition-all duration-150 active:scale-95"
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
              title="Switch Claude model"
            >
              <Sparkles
                className="shrink-0"
                style={{
                  width: keyboardSize === 'small' ? 14 : 16,
                  height: keyboardSize === 'small' ? 14 : 16,
                }}
              />
              MODEL
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

        {/* Mic button — far right */}
        {onVoice && (
          <button
            type="button"
            onClick={() => {
              navigator.vibrate?.(10)
              onVoice()
            }}
            className="flex items-center justify-center transition-all duration-150 active:scale-95"
            style={{
              ...btnStyle,
              ...topRowButtonStyle,
            }}
            title="Voice input"
          >
            <Mic
              className="shrink-0"
              style={{ width: iconSize, height: iconSize }}
            />
          </button>
        )}
      </div>

      {/* Row 2: [ESC]  ·  [← ↑ ↓ →]  ·  [CTRL] */}
      <div
        className="flex items-center justify-center"
        style={{ gap: spacing.arrowGroupGap }}
      >
        <KeyboardKey
          label="ESC"
          onPress={handleEsc}
          className="text-[10px]"
          style={{
            width: smallKeySize,
            height: smallKeySize,
            minWidth: smallKeySize,
          }}
        />

        {/* Arrow keys — large targets with wide spacing */}
        <div
          className="flex items-center"
          style={{ gap: spacing.arrowGroupGap }}
        >
          <KeyboardKey
            label="←"
            onPress={handleArrowLeft}
            className="text-xl"
            style={{
              width: arrowButtonSize,
              height: arrowButtonSize,
              minWidth: arrowButtonSize,
            }}
          />
          <KeyboardKey
            label="↑"
            onPress={handleArrowUp}
            className="text-xl"
            style={{
              width: arrowButtonSize,
              height: arrowButtonSize,
              minWidth: arrowButtonSize,
            }}
          />
          <KeyboardKey
            label="↓"
            onPress={handleArrowDown}
            className="text-xl"
            style={{
              width: arrowButtonSize,
              height: arrowButtonSize,
              minWidth: arrowButtonSize,
            }}
          />
          <KeyboardKey
            label="→"
            onPress={handleArrowRight}
            className="text-xl"
            style={{
              width: arrowButtonSize,
              height: arrowButtonSize,
              minWidth: arrowButtonSize,
            }}
          />
        </div>

        <button
          type="button"
          onClick={onCtrlToggle}
          className="rounded-md text-[10px] font-medium transition-all duration-150 active:scale-95"
          style={{
            width: smallKeySize,
            height: smallKeySize,
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
