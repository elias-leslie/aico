'use client'

import { Check, X } from 'lucide-react'
import { useState } from 'react'
import { AGENT_DEFAULT_COLORS } from '@/components/AgentIcon'

export interface ToolFormData {
  name: string
  slug: string
  command: string
  process_name: string
  description: string
  color: string
  /** Comma-separated alternate slugs (e.g. `claude` for `claude-code`). */
  aliases: string
}

export const EMPTY_FORM: ToolFormData = {
  name: '',
  slug: '',
  command: '',
  process_name: '',
  description: '',
  color: '#00FF9F',
  aliases: '',
}

export function parseAliases(value: string): string[] {
  const seen = new Set<string>()
  for (const raw of value.split(',')) {
    const alias = slugify(raw)
    if (alias) seen.add(alias)
  }
  return [...seen]
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-|-$/g, '')
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function normalizeColor(value: string): string {
  const trimmed = value.trim()
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 8px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  backgroundColor: 'var(--term-bg-surface)',
  border: '1px solid var(--term-border)',
  borderRadius: 4,
  color: 'var(--term-text-primary)',
  outline: 'none',
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
}

// Note: inputs use className="term-input" for CSS focus ring defined in globals.css

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 10,
  color: 'var(--term-text-muted)',
  marginBottom: 2,
  fontFamily: 'var(--font-mono)',
}

export function ToolForm({
  initial,
  onSubmit,
  onCancel,
  isEdit,
  contextHook = null,
}: {
  initial: ToolFormData
  onSubmit: (data: ToolFormData) => Promise<void>
  onCancel: () => void
  isEdit: boolean
  /** Read-only: the registry's launch-time context check for this tool. */
  contextHook?: string | null
}) {
  // The seeded shell tool has an empty command (a bare login shell); only
  // a tool that already has one may keep it empty.
  const commandRequired = !isEdit || initial.command.trim() !== ''
  const [form, setForm] = useState(initial)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleNameChange = (name: string) => {
    const newSlug = slugify(name)
    setForm((f) => ({
      ...f,
      name,
      ...(!isEdit
        ? {
            slug: newSlug,
            ...(AGENT_DEFAULT_COLORS[newSlug]
              ? { color: AGENT_DEFAULT_COLORS[newSlug] }
              : {}),
          }
        : {}),
    }))
  }

  const handleCommandChange = (command: string) => {
    setForm((f) => {
      const nextCommand = command
      const nextProcessName =
        f.process_name || normalizeCommand(command).split(' ')[0] || ''
      return {
        ...f,
        command: nextCommand,
        process_name: nextProcessName,
      }
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedName = form.name.trim()
    const normalizedSlug = slugify(form.slug)
    const normalizedCommand = normalizeCommand(form.command)
    const normalizedProcessName = normalizeCommand(form.process_name)
    const normalizedDescription = form.description.trim()
    const normalizedHex = normalizeColor(form.color)

    if (!trimmedName || (commandRequired && !normalizedCommand)) return
    if (!normalizedSlug) {
      setError(
        'Name must contain at least one letter or number (slug cannot be empty)',
      )
      return
    }
    if (normalizedHex && !/^#[0-9a-f]{6}$/i.test(normalizedHex)) {
      setError('Color must be a 6-digit hex value like #00FF9F')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        name: trimmedName,
        slug: normalizedSlug,
        command: normalizedCommand,
        process_name: normalizedProcessName,
        description: normalizedDescription,
        color: normalizedHex || EMPTY_FORM.color,
        aliases: parseAliases(form.aliases).join(', '),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-2 p-2 rounded"
      style={{ backgroundColor: 'var(--term-bg-surface)' }}
    >
      <div>
        <label style={labelStyle}>Name *</label>
        <input
          className="term-input"
          style={inputStyle}
          value={form.name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="OpenCode"
          aria-label="Tool name"
        />
      </div>
      <div>
        <label style={labelStyle}>Slug {isEdit && '(read-only)'}</label>
        <input
          className="term-input"
          style={{ ...inputStyle, opacity: isEdit ? 0.5 : 1 }}
          value={form.slug}
          onChange={(e) =>
            !isEdit && setForm((f) => ({ ...f, slug: e.target.value }))
          }
          readOnly={isEdit}
          placeholder="opencode"
          aria-label="Tool slug"
        />
      </div>
      <div>
        <label style={labelStyle}>Command{commandRequired ? ' *' : ''}</label>
        <input
          className="term-input"
          style={inputStyle}
          value={form.command}
          onChange={(e) => handleCommandChange(e.target.value)}
          placeholder="codex --yolo"
          aria-label="Tool command"
        />
      </div>
      <div>
        <label style={labelStyle}>Process Name</label>
        <input
          className="term-input"
          style={inputStyle}
          value={form.process_name}
          onChange={(e) =>
            setForm((f) => ({ ...f, process_name: e.target.value }))
          }
          placeholder="codex"
          aria-label="Tool process name"
        />
      </div>
      <div>
        <label style={labelStyle}>Aliases</label>
        <input
          className="term-input"
          style={inputStyle}
          value={form.aliases}
          onChange={(e) => setForm((f) => ({ ...f, aliases: e.target.value }))}
          placeholder="claude, cc"
          aria-label="Tool aliases"
        />
      </div>
      {contextHook && (
        <div>
          <label style={labelStyle}>Context hook (read-only)</label>
          <input
            className="term-input"
            style={{ ...inputStyle, opacity: 0.5 }}
            value={contextHook}
            readOnly
            aria-label="Tool context hook"
          />
        </div>
      )}
      <div>
        <label style={labelStyle}>Description</label>
        <input
          className="term-input"
          style={inputStyle}
          value={form.description}
          onChange={(e) =>
            setForm((f) => ({ ...f, description: e.target.value }))
          }
          placeholder="Optional description"
          aria-label="Tool description"
        />
      </div>
      <div>
        <label style={labelStyle}>Color</label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={
              /^#[0-9a-f]{6}$/i.test(form.color) ? form.color : EMPTY_FORM.color
            }
            onChange={(e) =>
              setForm((f) => ({ ...f, color: e.target.value.toUpperCase() }))
            }
            style={{
              width: 28,
              height: 22,
              border: 'none',
              cursor: 'pointer',
              background: 'transparent',
            }}
            aria-label="Tool color picker"
          />
          <input
            className="term-input"
            style={{ ...inputStyle, flex: 1 }}
            value={form.color}
            onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
            placeholder="#00FF9F"
            aria-label="Tool color"
          />
        </div>
      </div>
      {error && (
        <div
          className="text-[10px]"
          role="alert"
          style={{ color: 'var(--term-error-text)' }}
        >
          {error}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={
            submitting ||
            !form.name ||
            (commandRequired && !form.command.trim()) ||
            !form.slug
          }
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
          style={{
            backgroundColor: 'var(--term-accent)',
            color: 'var(--term-accent-foreground)',
            opacity: submitting ? 0.5 : 1,
            fontFamily: 'var(--font-mono)',
          }}
        >
          <Check size={10} />
          {isEdit ? 'Save' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
          style={{
            backgroundColor: 'transparent',
            border: '1px solid var(--term-border)',
            color: 'var(--term-text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <X size={10} />
          Cancel
        </button>
      </div>
    </form>
  )
}
