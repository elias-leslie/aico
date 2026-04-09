import { apiFetch } from '@/lib/api-fetch'

export interface PaneFileTreeEntry {
  name: string
  path: string
  is_directory: boolean
  size?: number
  extension?: string | null
  children_count?: number
}

export interface PaneFileTreeResponse {
  entries: PaneFileTreeEntry[]
  path: string
  total: number
}

export interface PaneFileContentResponse {
  path: string
  name: string
  content: string | null
  size: number
  lines: number
  extension: string | null
  is_binary: boolean
  language: string | null
  truncated: boolean
}

function buildQueryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

export function fetchPaneFileTree(
  paneId: string,
  path = '',
): Promise<PaneFileTreeResponse> {
  return apiFetch<PaneFileTreeResponse>(
    `/api/a-term/panes/${paneId}/files/tree${buildQueryString({
      path: path || undefined,
    })}`,
    undefined,
    'Failed to load pane files',
  )
}

export function fetchPaneFileContent(
  paneId: string,
  path: string,
): Promise<PaneFileContentResponse> {
  return apiFetch<PaneFileContentResponse>(
    `/api/a-term/panes/${paneId}/files/content${buildQueryString({ path })}`,
    undefined,
    'Failed to load file contents',
  )
}
