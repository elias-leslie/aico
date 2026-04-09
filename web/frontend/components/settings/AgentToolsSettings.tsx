'use client'

import { Plus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { ConfirmationDialog } from '@/components/ConfirmationDialog'
import { type AgentTool, useAgentTools } from '@/lib/hooks/use-agent-tools'
import { EMPTY_FORM, ToolForm, type ToolFormData } from './ToolForm'
import { ToolRow } from './ToolRow'

export function AgentToolsSettings() {
  const { agentTools, create, update, remove } = useAgentTools()
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingTool, setEditingTool] = useState<AgentTool | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [deletingTool, setDeletingTool] = useState<AgentTool | null>(null)

  const handleCreate = useCallback(
    async (data: ToolFormData) => {
      try {
        await create({
          name: data.name,
          slug: data.slug,
          command: data.command,
          process_name: data.process_name,
          description: data.description || undefined,
          color: data.color || undefined,
        })
        setFeedback(null)
        setShowAddForm(false)
      } catch (err) {
        setFeedback(
          err instanceof Error ? err.message : 'Failed to create tool',
        )
      }
    },
    [create],
  )

  const handleUpdate = useCallback(
    async (data: ToolFormData) => {
      if (!editingTool) return
      try {
        await update(editingTool.id, {
          name: data.name,
          command: data.command,
          process_name: data.process_name,
          description: data.description || undefined,
          color: data.color || undefined,
        })
        setFeedback(null)
        setEditingTool(null)
      } catch (err) {
        setFeedback(
          err instanceof Error ? err.message : 'Failed to update tool',
        )
      }
    },
    [editingTool, update],
  )

  const confirmDelete = useCallback(async () => {
    if (!deletingTool) return
    try {
      await remove(deletingTool.id)
      setFeedback(null)
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to delete tool')
    } finally {
      setDeletingTool(null)
    }
  }, [deletingTool, remove])

  const handleSetDefault = useCallback(
    async (tool: AgentTool) => {
      try {
        await update(tool.id, { is_default: true })
        setFeedback(null)
      } catch (err) {
        setFeedback(
          err instanceof Error ? err.message : 'Failed to update default tool',
        )
      }
    },
    [update],
  )

  return (
    <div
      className="mt-4 pt-4"
      style={{ borderTop: '1px solid var(--term-border)' }}
    >
      <div className="flex items-center justify-between mb-2">
        <span
          className="text-[10px] font-medium tracking-wider"
          style={{
            color: 'var(--term-text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          AGENT TOOLS
        </span>
        {!showAddForm && !editingTool && (
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:bg-white/5 transition-colors"
            style={{
              color: 'var(--term-accent)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <Plus size={10} />
            Add
          </button>
        )}
      </div>

      {feedback && (
        <div
          className="mb-2 rounded px-2 py-1.5 text-[10px]"
          style={{
            backgroundColor: 'var(--term-error-muted)',
            color: 'var(--term-error-text)',
          }}
          role="alert"
        >
          {feedback}
        </div>
      )}

      <div className="space-y-1.5">
        {agentTools.map((tool) =>
          editingTool?.id === tool.id ? (
            <ToolForm
              key={tool.id}
              initial={{
                name: tool.name,
                slug: tool.slug,
                command: tool.command,
                process_name: tool.process_name,
                description: tool.description || '',
                color: tool.color || '#00FF9F',
              }}
              onSubmit={handleUpdate}
              onCancel={() => setEditingTool(null)}
              isEdit
            />
          ) : (
            <ToolRow
              key={tool.id}
              tool={tool}
              onEdit={() => setEditingTool(tool)}
              onDelete={() => setDeletingTool(tool)}
              onSetDefault={() => handleSetDefault(tool)}
            />
          ),
        )}

        {showAddForm && (
          <ToolForm
            initial={EMPTY_FORM}
            onSubmit={handleCreate}
            onCancel={() => setShowAddForm(false)}
            isEdit={false}
          />
        )}

        {agentTools.length === 0 && !showAddForm && (
          <div
            className="text-[10px] text-center py-2"
            style={{ color: 'var(--term-text-muted)' }}
          >
            No agent tools configured
          </div>
        )}
      </div>

      <ConfirmationDialog
        isOpen={deletingTool !== null}
        title="Delete Agent Tool"
        message={`Are you sure you want to delete "${deletingTool?.name}"? This cannot be undone.`}
        confirmText="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setDeletingTool(null)}
      />
    </div>
  )
}
