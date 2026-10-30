'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { clsx } from 'clsx'
import { Search, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { CHAT_TOOL_SLUG, useAgentTools } from '@/lib/hooks/use-agent-tools'
import {
  HOST_STATE_LABELS,
  startingLabel,
  useHostProjects,
  useHosts,
} from '@/lib/hooks/use-hosts'
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
  /** `mode` is an agent tool's slug, or `shell`; `host` a Tether peer, or
   * absent for this computer. A rejection keeps the dialog open with its
   * reason. */
  onStart: (
    projectId: string,
    rootPath: string | null,
    mode: string,
    host?: string,
  ) => void | Promise<void>
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
 * Start a session: pick an agent or a shell, then a project. The picker
 * stays put above the project list, which scrolls on its own.
 */
export function NewSessionDialog({
  isOpen,
  onClose,
  defaultProjectId,
  onStart,
  isMobile = false,
}: NewSessionDialogProps) {
  const local = useProjectSettings()
  const { enabledTools, defaultTool } = useAgentTools()
  const [query, setQuery] = useState('')
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null)
  const [kind, setKind] = useState<'agent' | 'shell'>('agent')
  const [pickedToolSlug, setPickedToolSlug] = useState<string | null>(null)
  const [pickedHost, setPickedHost] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const {
    hosts,
    isLoading: hostsLoading,
    isError: hostsError,
  } = useHosts(isOpen, starting && !!pickedHost)

  const tool =
    kind === 'agent'
      ? (enabledTools.find((t) => t.slug === pickedToolSlug) ?? defaultTool)
      : undefined
  // Agent Hub chats run here; everything else may run on a linked host.
  const hostable = tool?.slug !== CHAT_TOOL_SLUG
  const host =
    hostable && hosts.some((h) => h.name === pickedHost)
      ? (pickedHost ?? undefined)
      : undefined
  // A session on another host starts in one of that host's projects.
  const remote = useHostProjects(host)
  const { projects, isLoading, isError, refetch } = host ? remote : local

  const normalizedQuery = query.trim().toLowerCase()
  const visibleProjects = useMemo(
    () => projects.filter((p) => matchesProject(p, normalizedQuery)),
    [projects, normalizedQuery],
  )
  // A pick from another host's list falls back to this list's default.
  const projectId =
    (projects.some((p) => p.id === pickedProjectId) ? pickedProjectId : null) ??
    (projects.some((p) => p.id === defaultProjectId)
      ? defaultProjectId
      : projects[0]?.id) ??
    null
  const project = projects.find((p) => p.id === projectId)

  const close = () => {
    setQuery('')
    setPickedProjectId(null)
    setKind('agent')
    setPickedToolSlug(null)
    setPickedHost(null)
    setStartError(null)
    setStarting(false)
    onClose()
  }
  const start = async () => {
    if (!project || starting) return
    const mode = tool ? tool.slug : SHELL_MODE
    const started = host
      ? onStart(project.id, project.root_path, mode, host)
      : onStart(project.id, project.root_path, mode)
    if (!(started instanceof Promise)) {
      close()
      return
    }
    setStarting(true)
    setStartError(null)
    try {
      await started
      close()
    } catch (error) {
      setStarting(false)
      setStartError(
        error instanceof Error && error.message
          ? error.message
          : 'Couldn’t start the session.',
      )
    }
  }

  const startLabel = !project
    ? 'Start'
    : tool
      ? `Start ${tool.name} in ${project.name}`
      : `Start a shell in ${project.name}`
  const startText = host ? `${startLabel} on ${host}` : startLabel

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
          style={{ backgroundColor: 'var(--scrim)' }}
        />
        <Dialog.Content
          data-testid="new-session-dialog"
          aria-describedby={undefined}
          className={clsx(
            'lantern-sheet fixed z-[10001] flex flex-col overflow-hidden outline-none',
            isMobile
              ? 'lantern-rise inset-x-0 bottom-0 h-[84dvh] rounded-t-[14px]'
              : 'lantern-enter top-1/2 left-1/2 max-h-[min(90dvh,720px)] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-xl',
          )}
          style={{ color: 'var(--bone)' }}
        >
          {isMobile && (
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-9 rounded-full"
              style={{ backgroundColor: 'var(--paper-veil)' }}
            />
          )}
          <div className="flex items-center gap-2 pt-3.5 pr-2 pb-2 pl-[18px]">
            <Dialog.Title
              className="flex-1"
              style={{ font: '500 18px/1.2 var(--font-display)' }}
            >
              New session
            </Dialog.Title>
            <Dialog.Close aria-label="Close" className="lantern-icon-btn">
              <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Dialog.Close>
          </div>

          <div className="flex-none pb-1">
            <SectionTitle>Start</SectionTitle>
            <div className="px-[18px]">
              {enabledTools.length > 0 && (
                <fieldset aria-label="Session kind" className="lantern-seg">
                  {(['agent', 'shell'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={kind === value}
                      onClick={() => setKind(value)}
                    >
                      {value === 'agent' ? 'Agent' : 'Shell'}
                    </button>
                  ))}
                </fieldset>
              )}
              {kind === 'agent' && enabledTools.length > 0 && (
                <fieldset aria-label="Agent" className="lantern-tools mt-2.5">
                  {enabledTools.map((t) => (
                    <button
                      key={t.slug}
                      type="button"
                      aria-pressed={t.slug === tool?.slug}
                      onClick={() => setPickedToolSlug(t.slug)}
                      className="lantern-tool"
                    >
                      <AgentIcon
                        slug={t.slug}
                        color={getAgentColor(t.slug, t.color)}
                      />
                      <span className="truncate">{t.name}</span>
                    </button>
                  ))}
                </fieldset>
              )}
              {tool?.slug === CHAT_TOOL_SLUG && tool.description && (
                <p
                  className="mt-2 text-xs"
                  style={{ color: 'var(--mist)' }}
                  data-testid="new-session-tool-note"
                >
                  {tool.description}
                </p>
              )}
            </div>
          </div>

          {hostable && (hosts.length > 0 || hostsError) && (
            <div className="flex-none pb-1">
              <SectionTitle>Runs on</SectionTitle>
              {hostsError ? (
                <Note>Couldn’t load hosts. New sessions run here.</Note>
              ) : (
                <fieldset
                  aria-label="Runs on"
                  className="lantern-tools mx-[18px]"
                  data-testid="new-session-hosts"
                >
                  {[{ name: null, state: 'connected' as const }, ...hosts].map(
                    (h) => {
                      const note = h.name ? HOST_STATE_LABELS[h.state] : ''
                      return (
                        <button
                          key={h.name ?? ''}
                          type="button"
                          aria-pressed={(h.name ?? undefined) === host}
                          onClick={() => setPickedHost(h.name)}
                          className="lantern-tool"
                        >
                          <span className="truncate">
                            {h.name ?? 'This computer'}
                          </span>
                          {note && (
                            <span
                              className="ml-auto flex-none text-xs"
                              style={{ color: 'var(--mist)' }}
                            >
                              {note}
                            </span>
                          )}
                        </button>
                      )
                    },
                  )}
                </fieldset>
              )}
            </div>
          )}
          {hostable && hostsLoading && hosts.length === 0 && (
            <p className="sr-only" aria-live="polite">
              Loading hosts…
            </p>
          )}

          <div className="flex-1 overflow-y-auto overscroll-contain pb-2">
            <SectionTitle>Project</SectionTitle>
            <div className="px-[18px]">
              <label className="lantern-field">
                <Search className="h-4 w-4 flex-shrink-0" strokeWidth={1.7} />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a project"
                  aria-label="Find a project"
                  className="text-sm"
                />
              </label>
            </div>
            {isLoading ? (
              <Note>Loading projects…</Note>
            ) : isError ? (
              <Note>
                {host
                  ? `${remote.error?.message || `Couldn’t load projects on ${host}`}.`
                  : "Couldn't load projects."}{' '}
                <button
                  type="button"
                  onClick={() => void refetch()}
                  className="underline"
                  style={{ color: 'var(--lantern)' }}
                >
                  Try again
                </button>
              </Note>
            ) : projects.length === 0 ? (
              <Note>{host ? `No projects on ${host}.` : 'No projects.'}</Note>
            ) : visibleProjects.length === 0 ? (
              <Note>No project matches “{query.trim()}”.</Note>
            ) : (
              <div
                role="radiogroup"
                aria-label="Project"
                className="mx-2 mt-2 flex flex-col"
              >
                {visibleProjects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={p.id === projectId}
                    onClick={() => setPickedProjectId(p.id)}
                    className="lantern-choice"
                  >
                    <span aria-hidden="true" className="radio" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{p.name}</span>
                      {p.root_path && (
                        <span className="path block truncate">
                          {p.root_path}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div
            className="flex-none px-[18px] pt-2.5 pb-[18px]"
            style={{ borderTop: '1px solid var(--paper)' }}
          >
            {startError && (
              <p
                role="alert"
                className="mb-2 text-sm"
                style={{ color: 'var(--bone)' }}
                data-testid="new-session-error"
              >
                {startError}
              </p>
            )}
            <button
              type="button"
              onClick={() => void start()}
              disabled={!project || starting}
              className="lantern-btn primary h-11! w-full text-sm!"
            >
              {starting
                ? (startingLabel(hosts.find((h) => h.name === host)) ??
                  'Starting…')
                : startText}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="lantern-sec mx-[18px] mt-3.5 mb-1.5">{children}</h3>
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-[18px] pt-3 text-sm" style={{ color: 'var(--mist)' }}>
      {children}
    </p>
  )
}
