import { useQuery } from '@tanstack/react-query'
import {
  type FilesSource,
  fetchFileContent,
  fetchFileTree,
  type PaneFileContentResponse,
  type PaneFileTreeResponse,
  sourceKey,
} from '@/lib/api/pane-files'
import { isPermanentRefusal } from '@/lib/api-fetch'

const fileQueryKeys = {
  all: ['pane-files'] as const,
  tree: (source: FilesSource, path: string) =>
    [...fileQueryKeys.all, 'tree', sourceKey(source), path] as const,
  content: (source: FilesSource, path: string) =>
    [...fileQueryKeys.all, 'content', sourceKey(source), path] as const,
}

/** A permanent refusal (another host's files, a path that is gone) shows at
 * once; anything else is retried as usual. */
function retryFiles(failures: number, error: Error): boolean {
  return !isPermanentRefusal(error) && failures < 3
}

export function useFileTree(source: FilesSource, path = '', enabled = true) {
  return useQuery<PaneFileTreeResponse>({
    queryKey: fileQueryKeys.tree(source, path),
    queryFn: () => fetchFileTree(source, path),
    enabled,
    staleTime: 10_000,
    retry: retryFiles,
  })
}

export function useFileContent(
  source: FilesSource,
  path: string | null,
  enabled = true,
) {
  return useQuery<PaneFileContentResponse>({
    queryKey: fileQueryKeys.content(source, path ?? ''),
    queryFn: () => fetchFileContent(source, path!),
    enabled: enabled && !!path,
    staleTime: 10_000,
    retry: retryFiles,
  })
}
