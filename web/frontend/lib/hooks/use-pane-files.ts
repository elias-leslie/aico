import { useQuery } from '@tanstack/react-query'
import {
  fetchPaneFileContent,
  fetchPaneFileTree,
  type PaneFileContentResponse,
  type PaneFileTreeResponse,
} from '@/lib/api/pane-files'

const fileQueryKeys = {
  all: ['pane-files'] as const,
  tree: (paneId: string, path: string) =>
    [...fileQueryKeys.all, 'tree', paneId, path] as const,
  content: (paneId: string, path: string) =>
    [...fileQueryKeys.all, 'content', paneId, path] as const,
}

export function usePaneFileTree(paneId: string, path = '', enabled = true) {
  return useQuery<PaneFileTreeResponse>({
    queryKey: fileQueryKeys.tree(paneId, path),
    queryFn: () => fetchPaneFileTree(paneId, path),
    enabled: enabled && !!paneId,
    staleTime: 10_000,
  })
}

export function usePaneFileContent(
  paneId: string,
  path: string | null,
  enabled = true,
) {
  return useQuery<PaneFileContentResponse>({
    queryKey: fileQueryKeys.content(paneId, path ?? ''),
    queryFn: () => fetchPaneFileContent(paneId, path!),
    enabled: enabled && !!paneId && !!path,
    staleTime: 10_000,
  })
}
