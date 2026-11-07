'use client'

import { FolderKanban } from 'lucide-react'
import type { NotesScope } from '@/lib/api/notes'
import { useNoteProjects } from '@/lib/hooks/use-note-projects'

/** The project's name, small, for a note in All: where it belongs. */
export function ProjectTag({ project }: { project: string }) {
  const { nameOf } = useNoteProjects()
  return (
    <span
      className="lantern-chip max-w-40"
      data-testid="note-project"
      title={`Project: ${nameOf(project)}`}
    >
      <FolderKanban
        className="h-3 w-3 flex-none"
        strokeWidth={1.7}
        aria-hidden="true"
      />
      <span className="truncate">{nameOf(project)}</span>
    </span>
  )
}

/** Which notes the list shows, always on screen: this project's, or all of them. With no project
 * to narrow to (no session open) it says All and offers nothing else. */
export function NoteScope({
  scope,
  onChange,
}: {
  scope: NotesScope
  onChange: (all: boolean) => void
}) {
  const { nameOf } = useNoteProjects()
  if (!scope.project)
    return (
      <p
        className="flex min-h-11 items-center text-[13px]"
        style={{ color: 'var(--mist)' }}
        data-testid="notes-scope"
      >
        Showing all notes
      </p>
    )
  const name = nameOf(scope.project)
  return (
    <div
      className="lantern-seg [&_button]:min-h-11"
      role="group"
      aria-label="Notes shown"
      data-testid="notes-scope"
    >
      <button
        type="button"
        aria-pressed={!scope.all}
        title={`This project: ${name}`}
        onClick={() => onChange(false)}
      >
        <span className="block truncate px-2">{name}</span>
      </button>
      <button
        type="button"
        aria-pressed={scope.all}
        onClick={() => onChange(true)}
      >
        All notes
      </button>
    </div>
  )
}

/** The note's project, changeable: any project in the registry, or none (a global note). A project
 * the registry no longer lists stays selectable while the note has it. */
export function ProjectPicker({
  project,
  onChange,
}: {
  project: string | null
  onChange: (project: string | null) => void
}) {
  const { projects, loaded, nameOf } = useNoteProjects()
  const listed = project === null || projects.some((p) => p.id === project)
  return (
    <label
      className="flex items-center gap-2 text-[13px]"
      style={{ color: 'var(--mist)' }}
    >
      <span className="flex-none">Project</span>
      <select
        aria-label="Project"
        data-testid="note-project-picker"
        className="status-select min-h-11 min-w-0 flex-1 md:min-h-9"
        value={project ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">No project</option>
        {!listed && project && (
          <option value={project}>{loaded ? project : nameOf(project)}</option>
        )}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  )
}
