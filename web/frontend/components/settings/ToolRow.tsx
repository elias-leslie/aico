'use client'

import { Pencil, Star, Trash2 } from 'lucide-react'
import type { AgentTool } from '@/lib/hooks/use-agent-tools'
import { getAgentColor } from '@/components/AgentIcon'

export function ToolRow({
  tool,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  tool: AgentTool
  onEdit: () => void
  onDelete: () => void
  onSetDefault: () => void
}) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded group"
      style={{ backgroundColor: 'var(--term-bg-surface)', border: '1px solid var(--term-border)' }}
    >
      <div
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: getAgentColor(tool.slug, tool.color) }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] truncate" style={{ color: 'var(--term-text-primary)', fontFamily: 'var(--font-mono)' }}>
            {tool.name}
          </span>
          {tool.is_default && (
            <Star size={10} style={{ color: 'var(--term-accent)', flexShrink: 0 }} fill="currentColor" />
          )}
          {!tool.enabled && (
            <span className="text-[9px] px-1 rounded" style={{ backgroundColor: 'rgba(255,255,255,0.05)', color: 'var(--term-text-muted)' }}>
              disabled
            </span>
          )}
        </div>
        <div className="text-[9px] truncate" style={{ color: 'var(--term-text-muted)', fontFamily: 'var(--font-mono)' }}>
          {tool.command}
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {!tool.is_default && (
          <button
            onClick={onSetDefault}
            title="Set as default"
            aria-label={`Set ${tool.name} as default`}
            className="p-1 rounded hover:bg-white/5 transition-colors"
            style={{ color: 'var(--term-text-muted)' }}
          >
            <Star size={10} />
          </button>
        )}
        <button
          onClick={onEdit}
          title="Edit"
          aria-label={`Edit ${tool.name}`}
          className="p-1 rounded hover:bg-white/5 transition-colors"
          style={{ color: 'var(--term-text-muted)' }}
        >
          <Pencil size={10} />
        </button>
        <button
          onClick={onDelete}
          title="Delete"
          aria-label={`Delete ${tool.name}`}
          className="p-1 rounded hover:bg-white/5 transition-colors"
          style={{ color: 'var(--term-error)' }}
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  )
}
