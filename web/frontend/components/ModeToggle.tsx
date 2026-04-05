'use client'

import { Loader2, PanelsTopLeft } from 'lucide-react'
import { memo, useCallback, useRef, useState } from 'react'
import type { AgentTool } from '@/lib/hooks/use-agent-tools'
import { AgentIcon, getAgentColor } from './AgentIcon'
import { ModeTogglePopover } from './ModeTogglePopover'

/** Mode is either 'shell' for aterm mode, or an agent tool slug */
export type ATermMode = string

interface ModeToggleProps {
  value: ATermMode
  onChange: (mode: ATermMode) => void | Promise<void>
  disabled?: boolean
  isMobile?: boolean
  /** External loading state - when true, toggle is disabled and shows spinner */
  isLoading?: boolean
  /** Available agent tools. When >1, shows a popover instead of binary toggle. */
  agentTools?: AgentTool[]
}

// Animations defined in globals.css: mode-toggle-pulse, mode-toggle-spin, .mode-toggle-btn, .mode-toggle-glow

function ModeIcon({
  isCurrentlyLoading,
  isAgentMode,
  isHovered,
  isDisabled,
  accentColor,
  iconSize,
  agentSlug,
}: {
  isCurrentlyLoading: boolean
  isAgentMode: boolean
  isHovered: boolean
  isDisabled: boolean
  accentColor: string
  iconSize: number
  agentSlug: string
}) {
  if (isCurrentlyLoading)
    return (
      <Loader2
        width={iconSize}
        height={iconSize}
        className="mode-toggle-spin"
        style={{ color: accentColor }}
      />
    )
  if (isAgentMode)
    return (
      <AgentIcon
        slug={agentSlug}
        size={iconSize}
        color={accentColor}
      />
    )
  return (
    <PanelsTopLeft
      width={iconSize}
      height={iconSize}
      style={{
        color: isHovered && !isDisabled ? 'var(--term-text-primary)' : 'var(--term-text-muted)',
      }}
    />
  )
}

/**
 * Single-click toggle for switching between Shell and agent modes.
 * When only 1 agent tool: binary toggle (shell <-> agent).
 * When multiple tools: opens popover with all options.
 */
export const ModeToggle = memo(function ModeToggle({
  value,
  onChange,
  disabled = false,
  isMobile = false,
  isLoading = false,
  agentTools = [],
}: ModeToggleProps) {
  const [internalLoading, setInternalLoading] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [showPopover, setShowPopover] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const isCurrentlyLoading = isLoading || internalLoading
  const isDisabled = disabled || isCurrentlyLoading
  const isAgentMode = value !== 'shell'
  const activeTool = agentTools.find((t) => t.slug === value)
  const defaultTool = agentTools.find((t) => t.is_default) ?? agentTools[0]
  const fallbackAgentSlug = 'claude'
  const accentColor = getAgentColor(activeTool?.slug ?? fallbackAgentSlug, activeTool?.color)
  const hasMultipleTools = agentTools.length > 1

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isDisabled) return
      if (hasMultipleTools) { setShowPopover((prev) => !prev); return }
      const oppositeMode: ATermMode = isAgentMode ? 'shell' : defaultTool?.slug ?? fallbackAgentSlug
      setInternalLoading(true)
      try { await onChange(oppositeMode) } catch { /* caller handles errors */ } finally { setInternalLoading(false) }
    },
    [isAgentMode, onChange, isDisabled, hasMultipleTools, defaultTool],
  )

  const handleSelectMode = useCallback(
    async (mode: ATermMode) => {
      setShowPopover(false)
      if (mode === value) return
      setInternalLoading(true)
      try { await onChange(mode) } catch { /* caller handles errors */ } finally { setInternalLoading(false) }
    },
    [onChange, value],
  )

  const tooltipText = isCurrentlyLoading
    ? 'Switching mode...'
    : isAgentMode
      ? `${activeTool?.name ?? 'Agent'} mode — click for ${hasMultipleTools ? 'options' : 'Shell'}`
      : `Shell mode — click for ${hasMultipleTools ? 'options' : defaultTool?.name ?? 'Agent'}`

  const size = isMobile ? 32 : 26
  const iconSize = isMobile ? 16 : 14

  return (
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <button
          ref={buttonRef}
          data-testid="mode-toggle"
          onClick={handleClick}
          disabled={isDisabled}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className="mode-toggle-btn"
          style={{
            position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: size, height: size, borderRadius: 6, border: '1px solid',
            cursor: isDisabled ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            backgroundColor: isAgentMode
              ? `color-mix(in srgb, ${accentColor} 8%, transparent)`
              : isHovered && !isDisabled ? 'var(--term-bg-elevated)' : 'var(--term-bg-surface)',
            borderColor: isAgentMode
              ? 'var(--term-accent-muted)'
              : isHovered && !isDisabled ? 'var(--term-border-active)' : 'var(--term-border)',
            boxShadow: isAgentMode
              ? `0 0 8px color-mix(in srgb, ${accentColor} 20%, transparent), inset 0 0 12px color-mix(in srgb, ${accentColor} 10%, transparent)`
              : 'none',
            opacity: isDisabled ? 0.5 : 1,
          }}
          title={tooltipText}
          aria-label={tooltipText}
          aria-busy={isCurrentlyLoading}
        >
          {isAgentMode && !isCurrentlyLoading && (
            <span
              className="mode-toggle-glow"
              style={{ position: 'absolute', inset: -2, borderRadius: 8, border: `1px solid ${accentColor}`, opacity: 0.3 }}
            />
          )}
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform 0.2s ease, color 0.2s ease', transform: isHovered && !isDisabled && !isCurrentlyLoading ? 'scale(1.1)' : 'scale(1)' }}>
            <ModeIcon isCurrentlyLoading={isCurrentlyLoading} isAgentMode={isAgentMode} isHovered={isHovered} isDisabled={isDisabled} accentColor={accentColor} iconSize={iconSize} agentSlug={activeTool?.slug ?? fallbackAgentSlug} />
          </span>
          <span style={{ position: 'absolute', bottom: 2, right: 2, width: 4, height: 4, borderRadius: '50%', backgroundColor: isAgentMode ? accentColor : 'var(--term-text-muted)', opacity: isAgentMode ? 1 : 0.4, transition: 'all 0.2s ease', boxShadow: isAgentMode ? `0 0 4px ${accentColor}` : 'none' }} />
        </button>
        {showPopover && hasMultipleTools && (
          <ModeTogglePopover buttonRef={buttonRef} value={value} agentTools={agentTools} onClose={() => setShowPopover(false)} onSelectMode={handleSelectMode} />
        )}
      </div>
  )
})
