import { apiFetch } from '@/lib/api-fetch'

export interface NotesStatusResponse {
  storage_mode: 'standalone' | 'companion'
  project_catalog_source: 'local' | 'companion'
}

export function fetchNotesStatus(): Promise<NotesStatusResponse> {
  return apiFetch<NotesStatusResponse>(
    '/api/notes/status',
    undefined,
    'Failed to load notes status',
  )
}
