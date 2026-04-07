/**
 * Sub-components and helpers for ATermManagerModal.
 */
import * as Dialog from '@radix-ui/react-dialog'
import { Folder, PanelsTopLeft, Search, X } from 'lucide-react'
import type { RefObject } from 'react'
import { useHoverStyle } from '@/lib/hooks/use-hover-style'
import type { ProjectSetting } from '@/lib/hooks/use-project-settings'
import type { ATermPane } from '@/lib/hooks/use-a-term-panes'
import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'

export interface AttachableATermOption {
  id: string
  label: string
  description: string
  projectId: string | null
  kind: 'external-session' | 'detached-pane'
  actionId: string
}

export interface ProjectRowData {
  project: ProjectSetting
  paneCount: number
  attachableOptions: AttachableATermOption[]
}

export const iconStyle = { color: 'var(--term-accent)', flexShrink: 0 } as const
export const sectionHeaderStyle = { color: 'var(--term-text-muted)', fontFamily: 'var(--font-ui)' } as const

function formatProjectDescription(project: ProjectSetting, attachableCount: number): string {
  const path = project.root_path ?? 'no working directory'
  if (attachableCount === 0) {
    return path
  }
  const suffix = attachableCount === 1 ? '1 attachable session' : `${attachableCount} attachable sessions`
  return `${path} · ${suffix}`
}

export function formatSessionDescription(session: ATermSession): string {
  const location = session.working_dir || 'no working directory'
  return `${session.project_id ?? 'external'} · ${session.mode} · ${location}`
}

export function formatDetachedPaneDescription(pane: ATermPane): string {
  const activeSession = pane.sessions.find((session) => session.mode === pane.active_mode) ?? pane.sessions[0]
  const location = activeSession?.working_dir || 'no working directory'
  return `${pane.project_id ?? 'detached'} · ${pane.active_mode} · ${location}`
}

export function makeExternalAttachableOption(session: ATermSession): AttachableATermOption {
  return {
    id: session.id,
    label: `${session.name} (${session.mode})`,
    description: formatSessionDescription(session),
    projectId: session.project_id,
    kind: 'external-session',
    actionId: session.id,
  }
}

export function makeDetachedPaneAttachableOption(pane: ATermPane): AttachableATermOption {
  return {
    id: pane.id,
    label: `${pane.pane_name} (${pane.active_mode})`,
    description: formatDetachedPaneDescription(pane),
    projectId: pane.project_id,
    kind: 'detached-pane',
    actionId: pane.id,
  }
}

export function makeProjectSessionOptions(
  externalSessions: ATermSession[],
  detachedPanes: ATermPane[],
): AttachableATermOption[] {
  return [
    ...externalSessions.map(makeExternalAttachableOption),
    ...detachedPanes.map(makeDetachedPaneAttachableOption),
  ].sort((a, b) => a.label.localeCompare(b.label))
}

export function matchesProjectRow(row: ProjectRowData, query: string): boolean {
  if (!query) return true
  const searchable = [
    row.project.name,
    row.project.root_path ?? '',
    ...row.attachableOptions.flatMap((option) => [option.label, option.description]),
  ]
  return searchable.join(' ').toLowerCase().includes(query)
}

export function filterAndSortSessions(
  sessions: AttachableATermOption[],
  query: string,
): AttachableATermOption[] {
  const sorted = [...sessions].sort((a, b) => a.label.localeCompare(b.label))
  if (!query) return sorted
  return sorted.filter((session) =>
    `${session.label} ${session.description}`.toLowerCase().includes(query)
  )
}

export function SectionHeader({ title, countLabel }: { title: string; countLabel: string }) {
  return (
    <div
      className="mb-2.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.16em]"
      style={sectionHeaderStyle}
    >
      <span>{title}</span>
      <span className="text-[10px] font-normal tracking-[0.12em]" style={{ color: 'var(--term-text-muted)', opacity: 0.7 }}>{countLabel}</span>
    </div>
  )
}

function ActionButton({
  label,
  onClick,
  muted = false,
  accent = false,
  disabled = false,
}: {
  label: string
  onClick: () => void
  muted?: boolean
  accent?: boolean
  disabled?: boolean
}) {
  const hoverStyle = useHoverStyle({
    hoverBg: accent ? 'color-mix(in srgb, var(--term-accent) 15%, transparent)' : 'var(--term-bg-surface)',
    defaultBg: accent ? 'color-mix(in srgb, var(--term-accent) 8%, transparent)' : 'transparent',
    hoverColor: accent ? 'var(--term-accent)' : 'var(--term-text-primary)',
    defaultColor: muted ? 'var(--term-text-muted)' : accent ? 'var(--term-accent)' : 'var(--term-text-primary)',
  })

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.12em] transition-all duration-150"
      style={{
        ...hoverStyle.style,
        borderColor: accent ? 'color-mix(in srgb, var(--term-accent) 30%, transparent)' : 'var(--term-border)',
        fontFamily: 'var(--font-ui)',
        opacity: disabled ? 0.6 : 1,
      }}
      onMouseEnter={hoverStyle.onMouseEnter}
      onMouseLeave={hoverStyle.onMouseLeave}
    >
      {label}
    </button>
  )
}

interface ProjectSessionRowProps {
  row: ProjectRowData
  selectedSessionId: string | undefined
  onSelectSession: (projectId: string, sessionId: string) => void
  onAttachSession: (option: AttachableATermOption) => void
  onCreateProjectATerm: (projectId: string, rootPath: string | null) => void
}

export function ProjectSessionRow({
  row,
  selectedSessionId,
  onSelectSession,
  onAttachSession,
  onCreateProjectATerm,
}: ProjectSessionRowProps) {
  const hoverStyle = useHoverStyle({
    hoverBg: 'var(--term-bg-elevated)',
    defaultBg: 'var(--term-bg-surface)',
    hoverColor: 'var(--term-text-primary)',
    defaultColor: 'var(--term-text-secondary)',
  })
  const selectedOption = row.attachableOptions.find((option) => option.id === selectedSessionId)
  const attachTarget = selectedOption ?? row.attachableOptions[0] ?? null

  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3.5 py-3 transition-all duration-150"
      style={{
        ...hoverStyle.style,
        border: '1px solid var(--term-border)',
        borderLeftWidth: 3,
        borderLeftColor: row.paneCount > 0 ? 'var(--term-accent)' : 'var(--term-border)',
      }}
      onMouseEnter={hoverStyle.onMouseEnter}
      onMouseLeave={hoverStyle.onMouseLeave}
    >
      <Folder size={16} style={iconStyle} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium truncate" style={{ fontFamily: 'var(--font-ui)' }}>{row.project.name}</span>
        <span className="block text-[11px] truncate" style={{ color: 'var(--term-text-muted)', fontFamily: 'var(--font-mono)' }}>
          {formatProjectDescription(row.project, row.attachableOptions.length)}
        </span>
      </span>
      {row.paneCount > 0 && (
        <span
          className="text-[10px] font-medium px-2 py-0.5 rounded-full"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--term-accent) 12%, transparent)',
            color: 'var(--term-accent)',
            fontFamily: 'var(--font-ui)',
          }}
        >
          {row.paneCount} open
        </span>
      )}
      {row.attachableOptions.length > 1 && (
        <label className="sr-only" htmlFor={`project-session-select-${row.project.id}`}>
          Select existing session for {row.project.name}
        </label>
      )}
      {row.attachableOptions.length > 1 && (
        <select
          id={`project-session-select-${row.project.id}`}
          value={attachTarget?.id ?? ''}
          onChange={(event) => onSelectSession(row.project.id, event.target.value)}
          className="max-w-[220px] rounded-md px-2.5 py-1.5 text-xs outline-none"
          style={{
            backgroundColor: 'var(--term-bg-deep)',
            border: '1px solid var(--term-border)',
            color: 'var(--term-text-primary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {row.attachableOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      {attachTarget && (
        <ActionButton
          label="Attach"
          onClick={() => onAttachSession(attachTarget)}
        />
      )}
      <ActionButton
        label="New"
        accent={!attachTarget}
        muted={Boolean(attachTarget)}
        onClick={() => onCreateProjectATerm(row.project.id, row.project.root_path)}
      />
    </div>
  )
}

interface SessionSectionProps {
  title: string
  countLabel: string
  total: number
  visible: AttachableATermOption[]
  searchQuery: string
  emptyLabel: string
  actionLabel: string
  onAction: (session: AttachableATermOption) => void
}

export function buildProjectRows(
  projects: ProjectSetting[],
  externalSessions: ATermSession[],
  detachedPanes: ATermPane[],
  paneCounts: Record<string, number>,
): ProjectRowData[] {
  const externalSessionMap = new Map<string, ATermSession[]>()
  const detachedPaneMap = new Map<string, ATermPane[]>()
  for (const session of externalSessions) {
    if (!session.project_id) continue
    const existing = externalSessionMap.get(session.project_id) ?? []
    existing.push(session)
    externalSessionMap.set(session.project_id, existing)
  }
  for (const pane of detachedPanes) {
    if (!pane.project_id) continue
    const existing = detachedPaneMap.get(pane.project_id) ?? []
    existing.push(pane)
    detachedPaneMap.set(pane.project_id, existing)
  }
  return projects.map((project) => ({
    project,
    paneCount: paneCounts[project.id] || 0,
    attachableOptions: makeProjectSessionOptions(
      externalSessionMap.get(project.id) ?? [],
      detachedPaneMap.get(project.id) ?? [],
    ),
  }))
}

export function ModalHeader() {
  const closeButtonHover = useHoverStyle({
    hoverBg: 'var(--term-bg-surface)',
    defaultBg: 'transparent',
    hoverColor: 'var(--term-text-primary)',
    defaultColor: 'var(--term-text-muted)',
  })
  return (
    <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--term-border)' }}>
      <div className="min-w-0">
        <Dialog.Title
          className="text-sm font-semibold tracking-wide"
          style={{ color: 'var(--term-text-primary)', fontFamily: 'var(--font-ui)' }}
        >
          A-Term Manager
        </Dialog.Title>
        <Dialog.Description className="mt-0.5 text-xs" style={{ color: 'var(--term-text-muted)' }}>
          Create, attach, or manage A-Term sessions across projects.
        </Dialog.Description>
      </div>
      <Dialog.Close asChild>
        <button
          data-testid="a-term-manager-modal-close"
          className="flex items-center justify-center w-9 h-9 rounded-lg transition-all duration-150"
          onMouseEnter={closeButtonHover.onMouseEnter}
          onMouseLeave={closeButtonHover.onMouseLeave}
          style={closeButtonHover.style}
          aria-label="Close A-Term manager"
        >
          <X size={16} />
        </button>
      </Dialog.Close>
    </div>
  )
}

export function SearchBar({
  value,
  onChange,
  inputRef,
}: {
  value: string
  onChange: (value: string) => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  return (
    <div className="px-5 py-3" style={{ borderBottom: '1px solid var(--term-border)' }}>
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--term-text-muted)' }} />
        <input
          ref={inputRef}
          id="a-term-manager-search"
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Filter by project, session, tool, or path..."
          className="term-input w-full rounded-lg pl-9 pr-3 py-2.5 text-sm outline-none"
          style={{
            backgroundColor: 'var(--term-bg-deep)',
            border: '1px solid var(--term-border)',
            color: 'var(--term-text-primary)',
            fontFamily: 'var(--font-mono)',
            transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          }}
        />
      </div>
    </div>
  )
}

export function QuickStartSection({ paneCount, onCreateGeneric }: { paneCount: number; onCreateGeneric: () => void }) {
  return (
    <>
      <SectionHeader title="Quick Start" countLabel={`${paneCount} open`} />
      <button
        type="button"
        onClick={onCreateGeneric}
        className="interactive-row flex items-center gap-3 w-full px-3.5 py-3 min-h-[44px] rounded-lg text-left transition-all duration-150"
        style={{ fontFamily: 'var(--font-ui)', backgroundColor: 'var(--term-bg-surface)', border: '1px solid var(--term-border)' }}
      >
        <PanelsTopLeft size={16} style={iconStyle} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium truncate">New Ad-Hoc A-Term</span>
          <span className="block text-[11px] truncate" style={{ color: 'var(--term-text-muted)', fontFamily: 'var(--font-mono)' }}>
            Scratch shell outside any project
          </span>
        </span>
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] px-2.5 py-1 rounded-md" style={{
          color: 'var(--term-accent)',
          backgroundColor: 'color-mix(in srgb, var(--term-accent) 8%, transparent)',
          border: '1px solid color-mix(in srgb, var(--term-accent) 20%, transparent)',
        }}>
          New
        </span>
      </button>
    </>
  )
}

export function NoMatchesBanner({ trimmedSearch }: { trimmedSearch: string }) {
  return (
    <div className="mt-6 text-center py-8 rounded-lg" style={{ backgroundColor: 'var(--term-bg-surface)', border: '1px solid var(--term-border)' }}>
      <p className="text-sm" style={{ color: 'var(--term-text-muted)' }}>
        No A-Terms match &quot;{trimmedSearch}&quot;
      </p>
      <p className="text-xs mt-1" style={{ color: 'var(--term-text-muted)', opacity: 0.6 }}>
        Try a different search term or create a new A-Term.
      </p>
    </div>
  )
}

export function SessionSection({
  title,
  countLabel,
  total,
  visible,
  searchQuery,
  emptyLabel,
  actionLabel,
  onAction,
}: SessionSectionProps) {
  if (total === 0) return null
  return (
    <div className="pt-5">
      <SectionHeader title={title} countLabel={countLabel} />
      <div className="space-y-1.5">
        {visible.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => onAction(session)}
            className="interactive-row flex items-center gap-3 w-full px-3.5 py-3 min-h-[44px] rounded-lg text-left transition-all duration-150"
            style={{
              fontFamily: 'var(--font-ui)',
              backgroundColor: 'var(--term-bg-surface)',
              border: '1px solid var(--term-border)',
            }}
          >
            <PanelsTopLeft size={16} style={iconStyle} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium truncate">{session.label}</span>
              <span className="block text-[11px] truncate" style={{ color: 'var(--term-text-muted)', fontFamily: 'var(--font-mono)' }}>
                {session.description}
              </span>
            </span>
            <span className="text-[11px] font-medium uppercase tracking-[0.12em]" style={{ color: 'var(--term-text-muted)', flexShrink: 0, fontFamily: 'var(--font-ui)' }}>
              {actionLabel}
            </span>
          </button>
        ))}
      </div>
      {visible.length === 0 && (
        <p className="px-3 py-6 text-center text-sm" style={{ color: 'var(--term-text-muted)', fontFamily: 'var(--font-ui)' }}>
          No {emptyLabel} match &quot;{searchQuery}&quot;.
        </p>
      )}
    </div>
  )
}
