'use client'

import { useEffect, useState } from 'react'
import type { AgentTool } from '@/lib/hooks/use-agent-tools'
import { AgentIcon, getAgentColor } from './AgentIcon'
import type { TerminalMode } from './ModeToggle'

interface ModeTogglePopoverProps {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  value: TerminalMode
  agentTools: AgentTool[]
  /** The running mode's name ("Shell", "Claude Code"). */
  currentLabel: string
  onClose: () => void
  onSelectMode: (mode: TerminalMode) => void
}

const MARGIN = 8
const WIDTH = 288

/** What each pick does from where the session is now, in a few words. */
function modeNote(current: TerminalMode, option: TerminalMode): string | null {
  if (option === current) return 'Running now'
  if (option === 'shell') return 'opens the shell'
  return current === 'shell' ? 'starts it' : 'restarts it'
}

/** The line under the heading: what switching does to what is running. */
function modeExplanation(current: TerminalMode, currentLabel: string): string {
  return current === 'shell'
    ? 'Picking an agent starts it in this project. The shell keeps running; pick Shell to go back to it.'
    : `Picking another agent stops ${currentLabel} and starts the new one here. Shell opens the shell and leaves ${currentLabel} running.`
}

export function ModeTogglePopover({
  buttonRef,
  value,
  agentTools,
  currentLabel,
  onClose,
  onSelectMode,
}: ModeTogglePopoverProps) {
  const [position, setPosition] = useState({ top: 0, left: 0 })

  useEffect(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN)
    setPosition({
      top: rect.bottom + 4,
      left: Math.max(
        MARGIN,
        Math.min(rect.left, window.innerWidth - width - MARGIN),
      ),
    })
  }, [buttonRef])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onClose()
      buttonRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [buttonRef, onClose])

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
        aria-label="Change what runs here"
        className="lantern-sheet lantern-enter fixed z-[10000] rounded-xl p-1.5"
        style={{ ...position, width: `min(${WIDTH}px, calc(100vw - 16px))` }}
      >
        <div className="px-2.5 pt-1.5 pb-2" data-testid="mode-explainer">
          <p
            className="text-[13px] font-semibold"
            style={{ color: 'var(--bone)' }}
          >
            Change what runs here
          </p>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--mist)' }}>
            {modeExplanation(value, currentLabel)}
          </p>
        </div>
        <hr
          className="mx-1.5 mb-1 border-0 border-t"
          style={{ borderColor: 'rgb(var(--glass-rgb) / 0.06)' }}
        />
        {[
          { slug: 'shell', name: 'Shell', color: undefined },
          ...agentTools,
        ].map((tool) => {
          const active = value === tool.slug
          const note = modeNote(value, tool.slug)
          return (
            <button
              key={tool.slug}
              type="button"
              role="menuitem"
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelectMode(tool.slug)}
              className="lantern-menu-item"
              style={{
                minHeight: 40,
                ...(active ? { color: 'var(--bone)' } : undefined),
              }}
            >
              <AgentIcon
                slug={tool.slug}
                size={16}
                color={getAgentColor(tool.slug, tool.color)}
              />
              <span>{tool.name}</span>
              {note && (
                <span
                  className="ml-auto text-xs"
                  style={{ color: active ? 'var(--lantern)' : 'var(--mist)' }}
                >
                  {note}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </>
  )
}
