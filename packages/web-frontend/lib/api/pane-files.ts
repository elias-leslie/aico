import { apiFetch } from '@/lib/api-fetch'

export interface PaneFileTreeEntry {
  name: string
  path: string
  is_directory: boolean
  size?: number
  extension?: string | null
  children_count?: number
  /** A symbolic link: `is_directory` and `size` describe what it leads to. */
  is_symlink?: boolean
  link_target?: string
  link_broken?: boolean
}

export interface PaneFileTreeResponse {
  entries: PaneFileTreeEntry[]
  path: string
  /** Every entry of the folder; a listing past one page has more to fetch. */
  total: number
  /** Where this page starts (only location listings are paged). */
  offset?: number
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

/** Where the browser reads: a tab's or a session's working folder, or any folder by its path (a share or a clicked path). */
export type FilesSource = ProjectSource | { kind: 'location'; root: string }

/** A session's project folder: its tab's, or (outside any tab) its own. */
export type ProjectSource =
  | { kind: 'pane'; paneId: string }
  | { kind: 'session'; sessionId: string }

export interface PathInfo {
  /** The real absolute path. */
  path: string
  kind: 'file' | 'folder'
}

function buildQueryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

function filesUrl(
  source: FilesSource,
  route: 'tree' | 'content',
  path: string | undefined,
  offset?: number,
): string {
  const query = buildQueryString({ path })
  if (source.kind === 'pane')
    return `/api/panes/${source.paneId}/files/${route}${query}`
  if (source.kind === 'session')
    return `/api/sessions/${source.sessionId}/files/${route}${query}`
  return `/api/files/${route}${buildQueryString({
    root: source.root,
    path,
    offset: offset ? String(offset) : undefined,
  })}`
}

/** A stable cache key for a source. */
export function sourceKey(source: FilesSource): string {
  if (source.kind === 'pane') return `pane:${source.paneId}`
  if (source.kind === 'session') return `session:${source.sessionId}`
  return `at:${source.root}`
}

export function fetchFileTree(
  source: FilesSource,
  path = '',
  offset = 0,
): Promise<PaneFileTreeResponse> {
  return apiFetch<PaneFileTreeResponse>(
    filesUrl(source, 'tree', path || undefined, offset),
    undefined,
    "Couldn't load the files",
  )
}

export function fetchFileContent(
  source: FilesSource,
  path: string,
): Promise<PaneFileContentResponse> {
  return apiFetch<PaneFileContentResponse>(
    filesUrl(source, 'content', path),
    undefined,
    "Couldn't open this file",
  )
}

/** The file itself, read where it is: text and images open in the browser, anything else downloads. */
export function rawFileUrl(root: string, path: string): string {
  return `/api/files/raw${buildQueryString({ root, path })}`
}

/** What a path names: its real location and whether it is a file or a folder. */
export function fetchPathInfo(path: string): Promise<PathInfo> {
  return apiFetch<PathInfo>(
    `/api/files/stat${buildQueryString({ path })}`,
    undefined,
    'This file was moved or deleted',
  )
}

/** Whether a file is a web page (opened rendered in its own tab, not as text). */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

/**
 * A shared HTML file, rendered in its own tab: the web server serves it (and
 * the files beside it) sandboxed, at a path-shaped URL so relative links resolve.
 */
export function sharedPageUrl(path: string): string {
  return `/api/files/page${path.split('/').map(encodeURIComponent).join('/')}`
}

/** Where a session's project folder is: a path here, or the host it is on. */
export interface ProjectRoot {
  root: string | null
  host: string | null
}

export function fetchProjectRoot(project: ProjectSource): Promise<ProjectRoot> {
  const base =
    project.kind === 'pane'
      ? `/api/panes/${project.paneId}/files`
      : `/api/sessions/${project.sessionId}/files`
  return apiFetch<ProjectRoot>(
    `${base}/root`,
    undefined,
    "Couldn't find the project folder",
  )
}

/** A shortcut: Home or a scratch folder on this computer. */
export interface FilePlace {
  id: string
  label: string
  path: string
}

export function fetchFilePlaces(): Promise<{ places: FilePlace[] }> {
  return apiFetch<{ places: FilePlace[] }>(
    '/api/files/places',
    undefined,
    "Couldn't load the shortcuts",
  )
}
