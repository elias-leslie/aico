'use client'

import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'
import { memo, useCallback, useRef, useState } from 'react'
import type { AgentTool } from '@/lib/hooks/use-agent-tools'
import { AgentIcon, getAgentColor } from './AgentIcon'
import { ModeTogglePopover } from './ModeTogglePopover'

/** Mode is either 'shell' for terminal mode, or an agent tool slug */
export type TerminalMode = string

interface ModeToggleProps {
  value: TerminalMode
  onChange: (mode: TerminalMode) => void | Promise<void>
  disabled?: boolean
  isMobile?: boolean
  /** External loading state - when true, toggle is disabled and shows spinner */
  isLoading?: boolean
  /** Available agent tools. When >1, shows a popover instead of binary toggle. */
  agentTools?: AgentTool[]
}

function ModeIcon({
  isCurrentlyLoading,
  accentColor,
  iconSize,
  slug,
}: {
  isCurrentlyLoading: boolean
  accentColor: string
  iconSize: number
  slug: string
}) {
  if (isCurrentlyLoading)
    return (
      <Loader2
        width={iconSize}
        height={iconSize}
        className="lantern-spin"
        style={{ color: accentColor }}
      />
    )
  return <AgentIcon slug={slug} size={iconSize} color={accentColor} />
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
  const [showPopover, setShowPopover] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const isCurrentlyLoading = isLoading || internalLoading
  const isAgentMode = value !== 'shell'
  const activeTool = agentTools.find((t) => t.slug === value)
  const defaultTool = agentTools.find((t) => t.is_default) ?? agentTools[0]
  const canEnterAgentMode = defaultTool !== undefined
  const isDisabled =
    disabled || isCurrentlyLoading || (!isAgentMode && !canEnterAgentMode)
  const activeAgentSlug = activeTool?.slug ?? defaultTool?.slug ?? 'agent'
  const accentColor = isAgentMode
    ? getAgentColor(activeAgentSlug, activeTool?.color ?? defaultTool?.color)
    : getAgentColor('shell')
  const hasMultipleTools = agentTools.length > 1

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isDisabled) return
      if (hasMultipleTools) {
        setShowPopover((prev) => !prev)
        return
      }
      if (!isAgentMode && !defaultTool) return
      const oppositeMode: TerminalMode = isAgentMode
        ? 'shell'
        : defaultTool.slug
      setInternalLoading(true)
      try {
        await onChange(oppositeMode)
      } catch {
        /* caller handles errors */
      } finally {
        setInternalLoading(false)
      }
    },
    [defaultTool, hasMultipleTools, isAgentMode, isDisabled, onChange],
  )

  const handleSelectMode = useCallback(
    async (mode: TerminalMode) => {
      setShowPopover(false)
      if (mode === value) return
      setInternalLoading(true)
      try {
        await onChange(mode)
      } catch {
        /* caller handles errors */
      } finally {
        setInternalLoading(false)
      }
    },
    [onChange, value],
  )

  const tooltipText = isCurrentlyLoading
    ? 'Switching mode...'
    : !isAgentMode && !defaultTool
      ? 'Shell mode — no agent tools configured'
      : isAgentMode
        ? `${activeTool?.name ?? 'Agent'} mode — click for ${hasMultipleTools ? 'options' : 'Shell'}`
        : `Shell mode — click for ${hasMultipleTools ? 'options' : (defaultTool?.name ?? 'Agent')}`

  const iconSize = isMobile ? 20 : 18

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        data-testid="mode-toggle"
        onClick={handleClick}
        disabled={isDisabled}
        className={clsx('lantern-icon-btn', !isMobile && 'compact')}
        style={{
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.5 : 1,
        }}
        title={tooltipText}
        aria-label={tooltipText}
        aria-busy={isCurrentlyLoading}
        aria-haspopup={hasMultipleTools ? 'menu' : undefined}
        aria-expanded={hasMultipleTools ? showPopover : undefined}
      >
        <ModeIcon
          isCurrentlyLoading={isCurrentlyLoading}
          accentColor={accentColor}
          iconSize={iconSize}
          slug={isAgentMode ? activeAgentSlug : 'shell'}
        />
      </button>
      {showPopover && hasMultipleTools && (
        <ModeTogglePopover
          buttonRef={buttonRef}
          value={value}
          agentTools={agentTools}
          onClose={() => setShowPopover(false)}
          onSelectMode={handleSelectMode}
        />
      )}
    </div>
  )
})
