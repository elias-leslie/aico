'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'

interface NoteProject {
  id: string
  name: string
}

/** Aico's projects, for naming a note's project and picking another. The same list (and cache
 * entry) the project settings read; a project's id is what a session and a note carry. */
export function useNoteProjects() {
  const query = useQuery({
    queryKey: ['terminal-projects'],
    queryFn: () =>
      apiFetch<NoteProject[]>(
        '/api/projects',
        undefined,
        "Couldn't load the projects",
      ),
    staleTime: 30_000,
  })
  const projects = query.data ?? []
  return {
    projects,
    /** False until the list has come (names fall back to ids until then). */
    loaded: query.data !== undefined,
    /** A project's name as the registry has it; the id itself when it is not there. */
    nameOf: (id: string) =>
      projects.find((project) => project.id === id)?.name ?? id,
  }
}
