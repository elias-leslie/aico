'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { clsx } from 'clsx'
import { Search } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import {
  pickerGlance,
  pickerSuffix,
  type QuotaGlance,
  quotaGlances,
} from '@/lib/frame/quota'
import { type AgentTool, useAgentTools } from '@/lib/hooks/use-agent-tools'
import {
  HOST_STATE_LABELS,
  startingLabel,
  useHostProjects,
  useHosts,
} from '@/lib/hooks/use-hosts'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import {
  type ProjectSetting,
  useProjectSettings,
} from '@/lib/hooks/use-project-settings'
import { useStatus } from '@/lib/hooks/use-status'
import { useUsage } from '@/lib/hooks/use-usage'
import { sessionHostLabel } from '@/lib/machines'
import { AgentIcon, getAgentColor } from './AgentIcon'
import { SheetHandle, SheetTitleBar } from './SheetChrome'

const SHELL_MODE = 'shell'
const LAST_PROJECT_KEY = 'aico:new-session-project'
const LAST_AGENT_KEY = 'aico:new-session-agent'
const MAX_NAME = 160

interface NewSessionDialogProps {
  isOpen: boolean
  onClose: () => void
  /** Preselected project: the open session's, else the project link's. */
  defaultProjectId?: string | null
  /** `mode` is an agent tool's slug, or `shell`; `host` a Tether peer, or
   * absent for this computer; `name` is the owner's own, when given. A
   * rejection keeps the dialog open with its reason. */
  onStart: (
    projectId: string,
    rootPath: string | null,
    mode: string,
    host?: string,
    name?: string,
  ) => void | Promise<void>
  /** The agent of the newest session, for a device that hasn't started one. */
  recentAgentSlug?: string | null
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
 * Start a session: pick an agent or a shell (the last one used is preselected),
 * then a project, and optionally name it. The picker stays put above the
 * project list, which scrolls on its own.
 */
/** The agent buttons, each with what its subscription has left. */
function AgentChoices({
  tools,
  glances,
  picked,
  onPick,
}: {
  tools: readonly AgentTool[]
  glances: readonly QuotaGlance[]
  picked: string | undefined
  onPick: (slug: string) => void
}) {
  return tools.map((t) => {
    const glance = pickerGlance(glances, [t.slug, ...t.aliases])
    const suffix = glance && pickerSuffix(glance)
    return (
      <button
        key={t.slug}
        type="button"
        aria-pressed={t.slug === picked}
        onClick={() => onPick(t.slug)}
        className="lantern-tool"
        title={glance?.answer}
      >
        <AgentIcon slug={t.slug} color={getAgentColor(t.slug, t.color)} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate">{t.name}</span>
          {suffix && (
            <span className="truncate text-xs" style={{ color: 'var(--mist)' }}>
              {suffix}
            </span>
          )}
        </span>
      </button>
    )
  })
}

export function NewSessionDialog({
  isOpen,
  onClose,
  defaultProjectId,
  onStart,
  recentAgentSlug,
  isMobile = false,
}: NewSessionDialogProps) {
  const local = useProjectSettings()
  const { enabledTools, defaultTool } = useAgentTools()
  // Only while open, so a closed dialog doesn't poll usage.
  const glances = quotaGlances(useUsage(isOpen).report)
  const [query, setQuery] = useState('')
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null)
  const [kind, setKind] = useState<'agent' | 'shell'>('agent')
  const [pickedToolSlug, setPickedToolSlug] = useState<string | null>(null)
  const [pickedHost, setPickedHost] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [lastToolSlug, setLastToolSlug] = useLocalStorageState<string | null>(
    LAST_AGENT_KEY,
    null,
  )
  const [lastProjectId, setLastProjectId] = useLocalStorageState<string | null>(
    LAST_PROJECT_KEY,
    null,
  )
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const {
    hosts,
    isLoading: hostsLoading,
    isError: hostsError,
  } = useHosts(isOpen, starting && !!pickedHost)
  // Status says which machine serves this page: on the Standby, "here" isn't the Workstation.
  useStatus()

  // The pick, else the agent this device started last, else the newest
  // session's, else the registry's default; past one with no plan to the next
  // that has one, unless it is picked.
  const enabledTool = (slug: string | null | undefined) =>
    enabledTools.find((t) => t.slug === slug)
  const rememberedTool =
    enabledTool(lastToolSlug) ?? enabledTool(recentAgentSlug)
  const hasPlan = (candidate: AgentTool | undefined) =>
    !!candidate &&
    pickerGlance(glances, [candidate.slug, ...candidate.aliases])?.state !==
      'no_plan'
  const tool =
    kind === 'agent'
      ? (enabledTool(pickedToolSlug) ??
        [rememberedTool, defaultTool, ...enabledTools].find(hasPlan) ??
        rememberedTool ??
        defaultTool)
      : undefined
  const toolIsLastUsed =
    !!tool && !pickedToolSlug && tool.slug === rememberedTool?.slug
  const host = hosts.some((h) => h.name === pickedHost)
    ? (pickedHost ?? undefined)
    : undefined
  // A session on another host starts in one of that host's projects.
  const remote = useHostProjects(host)
  // A host that is off can't list them; starting there turns it on, and its
  // projects sit at the same paths as here.
  const away =
    !!host &&
    remote.isError &&
    hosts.find((h) => h.name === host)?.state !== 'connected'
  const { projects, isLoading, isError, refetch } =
    host && !away ? remote : local

  const normalizedQuery = query.trim().toLowerCase()
  const visibleProjects = useMemo(
    () => projects.filter((p) => matchesProject(p, normalizedQuery)),
    [projects, normalizedQuery],
  )
  // The pick, else the project in view, else the last one started here, else
  // the first enabled one. A pick from another host's list falls back to
  // those. A project the search hides is not the choice: nothing names it.
  const inList = (id: string | null | undefined) =>
    projects.some((p) => p.id === id) ? id : null
  const projectId =
    inList(pickedProjectId) ??
    inList(defaultProjectId) ??
    inList(lastProjectId) ??
    projects.find((p) => p.enabled !== false)?.id ??
    null
  const project = visibleProjects.find((p) => p.id === projectId)

  const close = () => {
    setQuery('')
    setPickedProjectId(null)
    setKind('agent')
    setPickedToolSlug(null)
    setPickedHost(null)
    setName('')
    setStartError(null)
    setStarting(false)
    onClose()
  }
  const start = async () => {
    if (!project || starting) return
    const mode = tool ? tool.slug : SHELL_MODE
    const named = name.trim()
    const extra: [string?, string?] = named ? [host, named] : host ? [host] : []
    const started = onStart(project.id, project.root_path, mode, ...extra)
    const remember = () => {
      setLastProjectId(project.id)
      if (tool) setLastToolSlug(tool.slug)
    }
    if (!(started instanceof Promise)) {
      remember()
      close()
      return
    }
    setStarting(true)
    setStartError(null)
    try {
      await started
      remember()
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
    ? visibleProjects.length > 0
      ? 'Pick a project'
      : 'Start'
    : tool
      ? `Start ${tool.name} in ${project.name}`
      : `Start a shell in ${project.name}`
  const startText = host
    ? `${startLabel} on ${sessionHostLabel(host)}`
    : startLabel

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
              ? 'lantern-rise inset-x-0 bottom-0 h-[92dvh] rounded-t-[14px]'
              : 'lantern-enter top-1/2 left-1/2 max-h-[min(92dvh,820px)] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-xl',
          )}
          style={{ color: 'var(--bone)' }}
        >
          {isMobile && <SheetHandle />}
          <SheetTitleBar title="New session" />

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
                  <AgentChoices
                    tools={enabledTools}
                    glances={glances}
                    picked={tool?.slug}
                    onPick={setPickedToolSlug}
                  />
                </fieldset>
              )}
              {toolIsLastUsed && (
                <p
                  className="mt-1.5 text-xs"
                  style={{ color: 'var(--mist)' }}
                  data-testid="last-used-agent"
                >
                  {tool.name} was the last one you used.
                </p>
              )}
            </div>
          </div>

          {(hosts.length > 0 || hostsError) && (
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
                            {sessionHostLabel(h.name)}
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
          {hostsLoading && hosts.length === 0 && (
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
            {away && (
              <Note>{`${sessionHostLabel(host)} is off or out of reach. Starting a session there turns it on first.`}</Note>
            )}
            {isLoading ? (
              <Note>Loading projects…</Note>
            ) : isError ? (
              <Note>
                {host
                  ? `${remote.error?.message || `Couldn’t load projects on ${sessionHostLabel(host)}`}.`
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
              <Note>
                {host
                  ? `No projects on ${sessionHostLabel(host)}.`
                  : 'No projects.'}
              </Note>
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
            <label className="mb-2 flex items-center gap-2.5 text-xs">
              <span className="flex-none" style={{ color: 'var(--mist)' }}>
                Name <span className="font-normal">(optional)</span>
              </span>
              <span className="lantern-field min-w-0 flex-1">
                <input
                  type="text"
                  value={name}
                  maxLength={MAX_NAME}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void start()
                    }
                  }}
                  placeholder={project ? `Defaults to “${project.name}”` : ''}
                  aria-label="Name (optional)"
                  autoComplete="off"
                  className="text-sm"
                  data-testid="new-session-name"
                />
              </span>
            </label>
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
