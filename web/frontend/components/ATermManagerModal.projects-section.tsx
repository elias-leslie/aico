'use client'

import type { ProjectSetting } from '@/lib/hooks/use-project-settings'
import {
  type AttachableATermOption,
  type ProjectRowData,
  ProjectSessionRow,
  SectionHeader,
} from './ATermManagerModal.parts'
import { RegisterProjectCard } from './ATermManagerModal.register-project'

interface ProjectsSectionProps {
  isLoading: boolean
  isError: boolean
  error: unknown
  refetch: () => unknown
  canRegisterProjects: boolean
  projectRegistrySource: 'local' | 'companion'
  registerProjectName: string
  registerProjectRootPath: string
  registerProjectError: string | null
  isRegisteringProject: boolean
  projects: ProjectSetting[]
  visibleProjectRows: ProjectRowData[]
  selectedSessionsByProject: Record<string, string>
  trimmedSearch: string
  onRegisterProjectNameChange: (value: string) => void
  onRegisterProjectRootPathChange: (value: string) => void
  onRegisterProject: () => void
  onSelectSession: (projectId: string, sessionId: string) => void
  onAttachSession: (option: AttachableATermOption) => void
  onCreateProjectATerm: (projectId: string, rootPath: string | null) => void
}

export function ProjectsSection({
  isLoading,
  isError,
  error,
  refetch,
  canRegisterProjects,
  projectRegistrySource,
  registerProjectName,
  registerProjectRootPath,
  registerProjectError,
  isRegisteringProject,
  projects,
  visibleProjectRows,
  selectedSessionsByProject,
  trimmedSearch,
  onRegisterProjectNameChange,
  onRegisterProjectRootPathChange,
  onRegisterProject,
  onSelectSession,
  onAttachSession,
  onCreateProjectATerm,
}: ProjectsSectionProps) {
  const countLabel = isLoading
    ? 'Loading'
    : isError
      ? 'Unavailable'
      : `${visibleProjectRows.length} project${visibleProjectRows.length === 1 ? '' : 's'}`

  return (
    <div className="pt-5">
      <SectionHeader title="Projects" countLabel={countLabel} />
      <div className="space-y-1.5">
        {canRegisterProjects && (
          <RegisterProjectCard
            projectRegistrySource={projectRegistrySource}
            registerProjectName={registerProjectName}
            registerProjectRootPath={registerProjectRootPath}
            registerProjectError={registerProjectError}
            isRegisteringProject={isRegisteringProject}
            onRegisterProjectNameChange={onRegisterProjectNameChange}
            onRegisterProjectRootPathChange={onRegisterProjectRootPathChange}
            onRegisterProject={onRegisterProject}
          />
        )}
        {!isLoading && !isError && (
          <div className="space-y-1.5 pr-1 md:max-h-[420px] md:overflow-y-auto">
            {visibleProjectRows.map((row) => (
              <ProjectSessionRow
                key={row.project.id}
                row={row}
                selectedSessionId={selectedSessionsByProject[row.project.id]}
                onSelectSession={onSelectSession}
                onAttachSession={onAttachSession}
                onCreateProjectATerm={onCreateProjectATerm}
              />
            ))}
          </div>
        )}
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <div
              className="flex items-center gap-2 text-sm"
              style={{ color: 'var(--term-text-muted)' }}
            >
              <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
              <span>Loading project workspaces...</span>
            </div>
          </div>
        )}
        {isError && (
          <div
            className="px-3 py-6 text-center rounded-lg"
            style={{
              backgroundColor: 'var(--term-bg-surface)',
              border: '1px solid var(--term-border)',
            }}
          >
            <p className="text-sm" style={{ color: 'var(--term-text-muted)' }}>
              {error instanceof Error
                ? error.message
                : 'Failed to load project workspaces.'}
            </p>
            <button
              type="button"
              onClick={() => {
                void refetch()
              }}
              className="mt-3 rounded-md border px-3 py-2 text-xs font-medium uppercase tracking-[0.12em] transition-colors"
              style={{
                borderColor:
                  'color-mix(in srgb, var(--term-accent) 30%, transparent)',
                color: 'var(--term-accent)',
                fontFamily: 'var(--font-ui)',
              }}
            >
              Retry
            </button>
          </div>
        )}
        {!isLoading && !isError && projects.length === 0 && (
          <p
            className="px-3 py-6 text-center text-sm rounded-lg"
            style={{
              color: 'var(--term-text-muted)',
              backgroundColor: 'var(--term-bg-surface)',
              border: '1px solid var(--term-border)',
            }}
          >
            {canRegisterProjects
              ? 'No projects registered yet. Add a repo path above or open an ad-hoc shell.'
              : 'No projects found yet. Check the external project registry or open an ad-hoc shell.'}
          </p>
        )}
        {!isLoading &&
          !isError &&
          projects.length > 0 &&
          visibleProjectRows.length === 0 && (
            <p
              className="px-3 py-6 text-center text-sm rounded-lg"
              style={{
                color: 'var(--term-text-muted)',
                backgroundColor: 'var(--term-bg-surface)',
                border: '1px solid var(--term-border)',
              }}
            >
              No projects match &quot;{trimmedSearch}&quot;.
            </p>
          )}
      </div>
    </div>
  )
}
