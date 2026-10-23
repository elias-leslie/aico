'use client'

import { useEffect, useState } from 'react'
import type { AgentTool } from '@/lib/hooks/use-agent-tools'
import { AgentIcon, getAgentColor } from './AgentIcon'
import type { TerminalMode } from './ModeToggle'

interface ModeTogglePopoverProps {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  value: TerminalMode
  agentTools: AgentTool[]
  onClose: () => void
  onSelectMode: (mode: TerminalMode) => void
}

export function ModeTogglePopover({
  buttonRef,
  value,
  agentTools,
  onClose,
  onSelectMode,
}: ModeTogglePopoverProps) {
  const [position, setPosition] = useState({ top: 0, left: 0 })

  useEffect(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    setPosition(
      rect ? { top: rect.bottom + 4, left: rect.left } : { top: 0, left: 0 },
    )
  }, [buttonRef])

  return (
    <>
      <div
        className="fixed inset-0 z-[9999]"
        onClick={onClose}
        role="presentation"
        aria-hidden="true"
      />
      <div
        role="menu"
        aria-label="Select session mode"
        className="lantern-sheet lantern-enter fixed z-[10000] min-w-[200px] rounded-xl p-1.5"
        style={position}
      >
        {[
          { slug: 'shell', name: 'Shell', color: undefined },
          ...agentTools,
        ].map((tool) => {
          const active = value === tool.slug
          return (
            <button
              key={tool.slug}
              type="button"
              role="menuitem"
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelectMode(tool.slug)}
              className="lantern-menu-item"
              style={active ? { color: 'var(--bone)' } : undefined}
            >
              <AgentIcon
                slug={tool.slug}
                size={16}
                color={getAgentColor(tool.slug, tool.color)}
              />
              <span>{tool.name}</span>
              {active && (
                <span
                  aria-hidden="true"
                  className="ml-auto h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: 'var(--lantern)' }}
                />
              )}
            </button>
          )
        })}
      </div>
    </>
  )
}
