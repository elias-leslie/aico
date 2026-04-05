'use client'

import { PanelsTopLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentTool } from '@/lib/hooks/use-agent-tools'
import { AgentIcon, getAgentColor } from './AgentIcon'
import type { ATermMode } from './ModeToggle'

interface ModeTogglePopoverProps {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  value: ATermMode
  agentTools: AgentTool[]
  onClose: () => void
  onSelectMode: (mode: ATermMode) => void
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
    setPosition(rect ? { top: rect.bottom + 4, left: rect.left } : { top: 0, left: 0 })
  }, [buttonRef])

  return (
    <>
      <div className="fixed inset-0 z-[9999]" onClick={onClose} role="presentation" aria-hidden="true" />
      <div
        role="menu"
        aria-label="Select A-Term mode"
        className="fixed z-[10000] rounded-lg overflow-hidden animate-in fade-in slide-in-from-top-1 duration-100"
        style={{
          ...position,
          backgroundColor: 'var(--term-surface-glass)',
          backdropFilter: 'blur(12px)',
          border: '1px solid var(--term-border-active)',
          boxShadow: 'var(--term-shadow-dropdown)',
          minWidth: 180,
          fontFamily: 'var(--font-ui)',
        }}
      >
        <button
          role="menuitem"
          onClick={() => onSelectMode('shell')}
          className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left text-xs hover:bg-[var(--term-bg-surface)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--term-accent)]"
          style={{
            color: value === 'shell' ? 'var(--term-accent)' : 'var(--term-text-muted)',
          }}
        >
          <PanelsTopLeft size={14} />
          <span style={{ fontWeight: 500 }}>Shell</span>
          {value === 'shell' && <span className="ml-auto text-[10px]">●</span>}
        </button>
        {agentTools.map((tool) => (
          <button
            key={tool.slug}
            role="menuitem"
            onClick={() => onSelectMode(tool.slug)}
            className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left text-xs hover:bg-[var(--term-bg-surface)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--term-accent)]"
            style={{
              color:
                value === tool.slug
                  ? getAgentColor(tool.slug, tool.color)
                  : 'var(--term-text-muted)',
            }}
          >
            <AgentIcon slug={tool.slug} size={14} color={value === tool.slug ? getAgentColor(tool.slug, tool.color) : 'var(--term-text-muted)'} />
            <span style={{ fontWeight: 500 }}>{tool.name}</span>
            {value === tool.slug && <span className="ml-auto text-[10px]">●</span>}
          </button>
        ))}
      </div>
    </>
  )
}
