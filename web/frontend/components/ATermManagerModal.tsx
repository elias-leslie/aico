'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { useProjectSettings } from '@/lib/hooks/use-project-settings'
import type { ATermPane } from '@/lib/hooks/use-a-term-panes'
import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'
import {
  buildProjectRows,
  filterAndSortSessions,
  makeDetachedPaneAttachableOption,
  makeExternalAttachableOption,
  matchesProjectRow,
  ModalHeader,
  NoMatchesBanner,
  QuickStartSection,
  SearchBar,
  SessionSection,
  type AttachableATermOption,
} from './ATermManagerModal.parts'
import { ProjectsSection } from './ATermManagerModal.projects-section'

interface ATermManagerModalProps {
  isOpen: boolean
  onClose: () => void
  onCreateGenericATerm: () => void
  onCreateProjectATerm: (projectId: string, rootPath: string | null) => void
  externalSessions: ATermSession[]
  detachedPanes: ATermPane[]
  onAttachExternalSession: (sessionId: string) => void
  onAttachDetachedPane: (paneId: string) => void | Promise<void>
  panes: ATermPane[]
}

export function ATermManagerModal({
  isOpen,
  onClose,
  onCreateGenericATerm,
  onCreateProjectATerm,
  externalSessions,
  detachedPanes,
  onAttachExternalSession,
  onAttachDetachedPane,
  panes,
}: ATermManagerModalProps) {
  const {
    projects,
    isLoading,
    isError,
    error,
    refetch,
    canRegisterProjects,
    projectRegistrySource,
    registerProject,
    isUpdating,
  } = useProjectSettings()
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSessionsByProject, setSelectedSessionsByProject] = useState<Record<string, string>>({})
  const [registerProjectName, setRegisterProjectName] = useState('')
  const [registerProjectRootPath, setRegisterProjectRootPath] = useState('')
  const [registerProjectError, setRegisterProjectError] = useState<string | null>(null)
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const searchRef = useRef<HTMLInputElement>(null)

  const paneCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const pane of panes) {
      if (pane.pane_type === 'project' && pane.project_id) {
        counts[pane.project_id] = (counts[pane.project_id] || 0) + 1
      } else if (pane.pane_type === 'adhoc') {
        counts.__adhoc = (counts.__adhoc || 0) + 1
      }
    }
    return counts
  }, [panes])

  const normalizedSearch = deferredSearchQuery.trim().toLowerCase()

  const projectRows = useMemo(
    () => buildProjectRows(projects, externalSessions, detachedPanes, paneCounts),
    [projects, externalSessions, detachedPanes, paneCounts],
  )

  const visibleProjectRows = useMemo(
    () => projectRows.filter((row) => matchesProjectRow(row, normalizedSearch)),
    [projectRows, normalizedSearch],
  )

  const knownProjectIds = useMemo(
    () => new Set(projects.map((project) => project.id)),
    [projects],
  )

  const unmatchedExternalSessions = useMemo(
    () => externalSessions.filter((s) => !s.project_id || !knownProjectIds.has(s.project_id)),
    [externalSessions, knownProjectIds],
  )

  const unmatchedDetachedPanes = useMemo(
    () => detachedPanes.filter((p) => !p.project_id || !knownProjectIds.has(p.project_id)),
    [detachedPanes, knownProjectIds],
  )

  const visibleOtherSessions = useMemo(
    () => filterAndSortSessions([
      ...unmatchedExternalSessions.map(makeExternalAttachableOption),
      ...unmatchedDetachedPanes.map(makeDetachedPaneAttachableOption),
    ], normalizedSearch),
    [normalizedSearch, unmatchedDetachedPanes, unmatchedExternalSessions],
  )

  const resetModalState = () => {
    setSearchQuery('')
    setSelectedSessionsByProject({})
    setRegisterProjectName('')
    setRegisterProjectRootPath('')
    setRegisterProjectError(null)
  }
  const closeAndReset = () => { resetModalState(); onClose() }
  const handleCreateGeneric = () => { onCreateGenericATerm(); closeAndReset() }
  const handleCreateProjectATerm = (projectId: string, rootPath: string | null) => {
    onCreateProjectATerm(projectId, rootPath)
    closeAndReset()
  }
  const handleRegisterProject = async () => {
    const trimmedRootPath = registerProjectRootPath.trim()
    const trimmedName = registerProjectName.trim()
    if (!trimmedRootPath) {
      setRegisterProjectError('Project path is required.')
      return
    }
    try {
      setRegisterProjectError(null)
      const project = await registerProject({
        root_path: trimmedRootPath,
        name: trimmedName || undefined,
      })
      onCreateProjectATerm(project.id, project.root_path)
      closeAndReset()
    } catch (registerError) {
      setRegisterProjectError(
        registerError instanceof Error
          ? registerError.message
          : 'Failed to register project.',
      )
    }
  }
  const handleAttachOption = (option: AttachableATermOption) => {
    resetModalState()
    if (option.kind === 'detached-pane') {
      void onAttachDetachedPane(option.actionId)
    } else {
      onAttachExternalSession(option.actionId)
    }
  }
  const handleProjectSessionSelect = (projectId: string, sessionId: string) => {
    setSelectedSessionsByProject((current) => ({ ...current, [projectId]: sessionId }))
  }

  const trimmedSearch = deferredSearchQuery.trim()
  const noMatches = normalizedSearch && visibleProjectRows.length === 0 && visibleOtherSessions.length === 0

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) closeAndReset() }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000]"
          style={{
            backgroundColor: 'var(--term-overlay-backdrop)',
            backdropFilter: 'blur(8px)',
          }}
        />
        <Dialog.Content
          data-testid="a-term-manager-modal"
          className="fixed inset-x-3 top-3 bottom-3 z-[10001] flex flex-col overflow-hidden rounded-xl animate-in fade-in zoom-in-95 duration-150 sm:inset-x-6 sm:top-6 sm:bottom-6 md:left-1/2 md:right-auto md:top-1/2 md:bottom-auto md:w-[min(92vw,720px)] md:max-h-[min(98dvh,1100px)] md:-translate-x-1/2 md:-translate-y-1/2"
          style={{
            backgroundColor: 'var(--term-bg-elevated)',
            border: '1px solid var(--term-border-active)',
            boxShadow: 'var(--term-shadow-modal)',
            fontFamily: 'var(--font-ui)',
          }}
          onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus() }}
        >
          <ModalHeader />
          <SearchBar value={searchQuery} onChange={setSearchQuery} inputRef={searchRef} />
          <div
            data-testid="a-term-manager-scroll-region"
            className="flex-1 overflow-y-auto overscroll-contain px-5 py-4"
            aria-busy={isLoading}
          >
            <QuickStartSection paneCount={paneCounts.__adhoc || 0} onCreateGeneric={handleCreateGeneric} />
            <ProjectsSection
              isLoading={isLoading}
              isError={isError}
              error={error}
              refetch={refetch}
              canRegisterProjects={canRegisterProjects}
              projectRegistrySource={projectRegistrySource}
              registerProjectName={registerProjectName}
              registerProjectRootPath={registerProjectRootPath}
              registerProjectError={registerProjectError}
              isRegisteringProject={isUpdating}
              projects={projects}
              visibleProjectRows={visibleProjectRows}
              selectedSessionsByProject={selectedSessionsByProject}
              trimmedSearch={trimmedSearch}
              onRegisterProjectNameChange={(value) => {
                setRegisterProjectName(value)
                if (registerProjectError) setRegisterProjectError(null)
              }}
              onRegisterProjectRootPathChange={(value) => {
                setRegisterProjectRootPath(value)
                if (registerProjectError) setRegisterProjectError(null)
              }}
              onRegisterProject={handleRegisterProject}
              onSelectSession={handleProjectSessionSelect}
              onAttachSession={handleAttachOption}
              onCreateProjectATerm={handleCreateProjectATerm}
            />
            <SessionSection
              title="Other Attachables"
              countLabel={`${visibleOtherSessions.length} attachable${visibleOtherSessions.length === 1 ? '' : 's'}`}
              total={unmatchedExternalSessions.length + unmatchedDetachedPanes.length}
              visible={visibleOtherSessions}
              searchQuery={trimmedSearch}
              emptyLabel="other attachables"
              actionLabel="Attach"
              onAction={handleAttachOption}
            />
            {noMatches && <NoMatchesBanner trimmedSearch={trimmedSearch} />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
