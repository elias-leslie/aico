'use client'

import { useEffect, useState } from 'react'
import { useProjectSettings } from '@/lib/hooks/use-project-settings'

interface PaneProjectSwitcherProps {
  projectId: string
  onProjectSwitch: (
    projectId: string,
    rootPath: string | null,
  ) => Promise<void> | void
  isMobile?: boolean
}

export function PaneProjectSwitcher({
  projectId,
  onProjectSwitch,
  isMobile = false,
}: PaneProjectSwitcherProps) {
  const { projects, isLoading } = useProjectSettings()
  const [selectedProjectId, setSelectedProjectId] = useState(projectId)
  const [isSwitching, setIsSwitching] = useState(false)

  useEffect(() => {
    setSelectedProjectId(projectId)
  }, [projectId])

  return (
    <label className="min-w-0">
      <span className="sr-only">Switch pane project</span>
      <select
        value={selectedProjectId}
        disabled={isLoading || isSwitching || projects.length === 0}
        onChange={async (event) => {
          const nextProjectId = event.target.value
          setSelectedProjectId(nextProjectId)

          if (nextProjectId === projectId) {
            return
          }

          const nextProject = projects.find(
            (project) => project.id === nextProjectId,
          )
          if (!nextProject) {
            setSelectedProjectId(projectId)
            return
          }

          setIsSwitching(true)
          try {
            await onProjectSwitch(nextProject.id, nextProject.root_path)
          } catch {
            setSelectedProjectId(projectId)
          } finally {
            setIsSwitching(false)
          }
        }}
        className={`rounded-md px-2 py-1 text-[11px] outline-none ${isMobile ? 'max-w-[120px]' : 'max-w-[140px]'}`}
        style={{
          backgroundColor: 'var(--term-bg-deep)',
          border: '1px solid var(--term-border)',
          color: 'var(--term-text-primary)',
          fontFamily: 'var(--font-ui)',
        }}
        title="Switch pane project"
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
        {projects.length === 0 && (
          <option value={projectId}>
            {isLoading ? 'Loading projects...' : 'No projects'}
          </option>
        )}
      </select>
    </label>
  )
}
