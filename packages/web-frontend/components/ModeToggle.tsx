'use client'

import { clsx } from 'clsx'
import { ChevronDown, Loader2 } from 'lucide-react'
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
  /** Agent tools the session can run besides the shell. */
  agentTools?: AgentTool[]
}

/**
 * What runs in this session, as a labelled control ("Runs Claude Code"). It
 * opens the list with a line saying that switching restarts the process.
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

  const busy = isLoading || internalLoading
  const isAgentMode = value !== 'shell'
  const activeTool = agentTools.find((t) => t.slug === value)
  const label = isAgentMode ? (activeTool?.name ?? 'Agent') : 'Shell'
  const noAgents = agentTools.length === 0
  const isDisabled = disabled || busy || noAgents
  const accentColor = getAgentColor(
    isAgentMode ? value : 'shell',
    activeTool?.color,
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

  const text = busy
    ? 'Switching what runs here…'
    : noAgents
      ? 'This session runs a shell. No agents are set up to switch to.'
      : `Runs ${label}. Change what runs here: switching restarts the process.`

  return (
    <div className="relative inline-block min-w-0 flex-none">
      <button
        ref={buttonRef}
        type="button"
        data-testid="mode-toggle"
        onClick={(event) => {
          event.stopPropagation()
          if (!isDisabled) setShowPopover((open) => !open)
        }}
        disabled={isDisabled}
        className={clsx('lantern-mode', isMobile && 'phone')}
        title={text}
        aria-label={text}
        aria-busy={busy}
        aria-haspopup="menu"
        aria-expanded={showPopover}
      >
        {busy ? (
          <Loader2
            width={16}
            height={16}
            className="lantern-spin"
            style={{ color: accentColor }}
          />
        ) : (
          <AgentIcon
            slug={isAgentMode ? value : 'shell'}
            size={16}
            color={accentColor}
          />
        )}
        {!isMobile && <span className="k">Runs</span>}
        <span className="v">{label}</span>
        <ChevronDown
          className="h-3.5 w-3.5 flex-none"
          strokeWidth={1.7}
          aria-hidden="true"
        />
      </button>
      {showPopover && !noAgents && (
        <ModeTogglePopover
          buttonRef={buttonRef}
          value={value}
          agentTools={agentTools}
          currentLabel={label}
          onClose={() => setShowPopover(false)}
          onSelectMode={handleSelectMode}
        />
      )}
    </div>
  )
})
