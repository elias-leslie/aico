'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { clsx } from 'clsx'
import { Search, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import {
  type ProjectSetting,
  useProjectSettings,
} from '@/lib/hooks/use-project-settings'
import { AgentIcon, getAgentColor } from './AgentIcon'

const SHELL_MODE = 'shell'

interface NewSessionDialogProps {
  isOpen: boolean
  onClose: () => void
  /** Preselected project, e.g. the open session's. */
  defaultProjectId?: string | null
  /** `mode` is an agent tool's slug, or `shell`. */
  onStart: (projectId: string, rootPath: string | null, mode: string) => void
  isMobile?: boolean
}

function matchesProject(project: ProjectSetting, query: string): boolean {
  if (!query) return true
  return (
    project.name.toLowerCase().includes(query) ||
    (project.root_path ?? '').toLowerCase().includes(query)
  )
}

/**
 * Start a session: pick a project, then an agent or a shell.
 */
export function NewSessionDialog({
  isOpen,
  onClose,
  defaultProjectId,
  onStart,
  isMobile = false,
}: NewSessionDialogProps) {
  const { projects, isLoading, isError, refetch } = useProjectSettings()
  const { enabledTools, defaultTool } = useAgentTools()
  const [query, setQuery] = useState('')
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null)
  const [kind, setKind] = useState<'agent' | 'shell'>('agent')
  const [pickedToolSlug, setPickedToolSlug] = useState<string | null>(null)

  const normalizedQuery = query.trim().toLowerCase()
  const visibleProjects = useMemo(
    () => projects.filter((p) => matchesProject(p, normalizedQuery)),
    [projects, normalizedQuery],
  )
  const projectId =
    pickedProjectId ??
    (projects.some((p) => p.id === defaultProjectId)
      ? defaultProjectId
      : projects[0]?.id) ??
    null
  const project = projects.find((p) => p.id === projectId)
  const tool =
    kind === 'agent'
      ? (enabledTools.find((t) => t.slug === pickedToolSlug) ?? defaultTool)
      : undefined

  const close = () => {
    setQuery('')
    setPickedProjectId(null)
    setKind('agent')
    setPickedToolSlug(null)
    onClose()
  }
  const start = () => {
    if (!project) return
    onStart(project.id, project.root_path, tool ? tool.slug : SHELL_MODE)
    close()
  }

  const startLabel = !project
    ? 'Start'
    : tool
      ? `Start ${tool.name} in ${project.name}`
      : `Start a shell in ${project.name}`

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000]"
          style={{ backgroundColor: 'var(--term-overlay-backdrop)' }}
        />
        <Dialog.Content
          data-testid="new-session-dialog"
          aria-describedby={undefined}
          className={clsx(
            'fixed z-[10001] flex flex-col overflow-hidden outline-none',
            isMobile
              ? 'inset-x-0 bottom-0 h-[84dvh] rounded-t-2xl animate-in slide-in-from-bottom-3 duration-150'
              : 'left-1/2 top-1/2 max-h-[min(90dvh,720px)] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-xl animate-in fade-in zoom-in-95 duration-150',
          )}
          style={{
            backgroundColor: 'var(--term-bg-elevated)',
            border: '1px solid var(--term-border-active)',
            boxShadow: 'var(--term-shadow-modal)',
            fontFamily: 'var(--font-ui)',
            color: 'var(--term-text-primary)',
          }}
        >
          {isMobile && (
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-9 rounded-full"
              style={{ backgroundColor: 'var(--term-border)' }}
            />
          )}
          <div className="flex items-center justify-between px-4 pt-3 pb-1">
            <Dialog.Title className="text-base font-medium">
              New session
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-[var(--term-bg-surface)]"
              style={{ color: 'var(--term-text-muted)' }}
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto overscroll-contain pb-2">
            <SectionTitle>Project</SectionTitle>
            <div className="px-4">
              <label
                className="flex items-center gap-2 rounded-md px-3 py-2"
                style={{
                  backgroundColor: 'var(--term-bg-surface)',
                  border: '1px solid var(--term-border)',
                }}
              >
                <Search
                  className="h-4 w-4 flex-shrink-0"
                  style={{ color: 'var(--term-text-muted)' }}
                />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a project"
                  aria-label="Find a project"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  style={{ color: 'var(--term-text-primary)' }}
                />
              </label>
            </div>
            {isLoading ? (
              <Note>Loading projects…</Note>
            ) : isError ? (
              <Note>
                Couldn't load projects.{' '}
                <button
                  type="button"
                  onClick={() => void refetch()}
                  className="underline"
                  style={{ color: 'var(--term-accent)' }}
                >
                  Try again
                </button>
              </Note>
            ) : projects.length === 0 ? (
              <Note>No projects.</Note>
            ) : visibleProjects.length === 0 ? (
              <Note>No project matches “{query.trim()}”.</Note>
            ) : (
              <div
                role="radiogroup"
                aria-label="Project"
                className="mx-2 mt-2 flex flex-col"
              >
                {visibleProjects.map((p) => {
                  const checked = p.id === projectId
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      onClick={() => setPickedProjectId(p.id)}
                      className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--term-bg-surface)]"
                      style={{
                        backgroundColor: checked
                          ? 'var(--term-bg-surface)'
                          : undefined,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className="h-4 w-4 flex-shrink-0 rounded-full"
                        style={{
                          border: `1.5px solid ${checked ? 'var(--term-accent)' : 'var(--term-text-muted)'}`,
                          boxShadow: checked
                            ? 'inset 0 0 0 3px var(--term-bg-elevated), inset 0 0 0 8px var(--term-accent)'
                            : undefined,
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{p.name}</span>
                        {p.root_path && (
                          <span
                            className="block truncate text-[11.5px]"
                            style={{
                              color: 'var(--term-text-muted)',
                              fontFamily: 'var(--font-mono)',
                            }}
                          >
                            {p.root_path}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            <SectionTitle>Start</SectionTitle>
            <div className="px-4">
              {enabledTools.length > 0 && (
                <fieldset
                  aria-label="Session kind"
                  className="inline-flex rounded-md p-0.5"
                  style={{
                    backgroundColor: 'var(--term-bg-surface)',
                    border: '1px solid var(--term-border)',
                  }}
                >
                  {(['agent', 'shell'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={kind === value}
                      onClick={() => setKind(value)}
                      className="rounded px-4 py-1.5 text-sm transition-colors"
                      style={{
                        backgroundColor:
                          kind === value
                            ? 'var(--term-bg-elevated)'
                            : 'transparent',
                        color:
                          kind === value
                            ? 'var(--term-text-primary)'
                            : 'var(--term-text-muted)',
                      }}
                    >
                      {value === 'agent' ? 'Agent' : 'Shell'}
                    </button>
                  ))}
                </fieldset>
              )}
              {kind === 'agent' && enabledTools.length > 0 && (
                <fieldset
                  aria-label="Agent"
                  className="mt-2.5 flex flex-wrap gap-2"
                >
                  {enabledTools.map((t) => {
                    const pressed = t.slug === tool?.slug
                    return (
                      <button
                        key={t.slug}
                        type="button"
                        aria-pressed={pressed}
                        onClick={() => setPickedToolSlug(t.slug)}
                        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors"
                        style={{
                          backgroundColor: pressed
                            ? 'var(--term-bg-surface)'
                            : 'transparent',
                          border: `1px solid ${pressed ? 'var(--term-border-active)' : 'var(--term-border)'}`,
                        }}
                      >
                        <AgentIcon
                          slug={t.slug}
                          color={getAgentColor(t.slug, t.color)}
                        />
                        {t.name}
                      </button>
                    )
                  })}
                </fieldset>
              )}
            </div>
          </div>

          <div
            className="flex-none px-4 pt-2.5 pb-4"
            style={{ borderTop: '1px solid var(--term-border)' }}
          >
            <button
              type="button"
              onClick={start}
              disabled={!project}
              className="h-11 w-full rounded-md text-sm font-medium transition-[filter] hover:brightness-110 disabled:opacity-50"
              style={{
                backgroundColor: 'var(--term-accent)',
                color: 'var(--term-accent-foreground)',
              }}
            >
              {startLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h3
      className="px-4 pt-4 pb-2 text-[11px] uppercase tracking-wide"
      style={{ color: 'var(--term-text-muted)' }}
    >
      {children}
    </h3>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p
      className="px-4 pt-3 text-sm"
      style={{ color: 'var(--term-text-muted)' }}
    >
      {children}
    </p>
  )
}
