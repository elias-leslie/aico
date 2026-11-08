import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  type FilesSource,
  fetchFileContent,
  fetchFilePlaces,
  fetchFileTree,
  fetchProjectRoot,
  type ListingView,
  type PaneFileContentResponse,
  type PaneFileTreeEntry,
  type PaneFileTreeResponse,
  type ProjectSource,
  sourceKey,
} from '@/lib/api/pane-files'
import { isPermanentRefusal } from '@/lib/api-fetch'

const fileQueryKeys = {
  all: ['pane-files'] as const,
  tree: (source: FilesSource, path: string, view?: ListingView) =>
    [
      ...fileQueryKeys.all,
      'tree',
      sourceKey(source),
      path,
      view?.sort ?? '',
      view?.showHidden ?? '',
    ] as const,
  content: (source: FilesSource, path: string) =>
    [...fileQueryKeys.all, 'content', sourceKey(source), path] as const,
}

/** A permanent refusal (another host's files, a path that is gone) shows at
 * once; anything else is retried as usual. */
function retryFiles(failures: number, error: Error): boolean {
  return !isPermanentRefusal(error) && failures < 3
}

/** A folder's entries, a page at a time: `loadMore` fetches the next page. */
export function useFileTree(
  source: FilesSource,
  path = '',
  enabled = true,
  view?: ListingView,
) {
  const query = useInfiniteQuery<
    PaneFileTreeResponse,
    Error,
    { pages: PaneFileTreeResponse[] },
    readonly unknown[],
    number
  >({
    queryKey: fileQueryKeys.tree(source, path, view),
    queryFn: ({ pageParam }) => fetchFileTree(source, path, pageParam, view),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = (last.offset ?? 0) + last.entries.length
      return last.offset !== undefined &&
        last.entries.length > 0 &&
        next < last.total
        ? next
        : undefined
    },
    enabled,
    staleTime: 10_000,
    retry: retryFiles,
  })
  const pages = query.data?.pages
  return {
    entries: pages?.flatMap((page) => page.entries) as
      | PaneFileTreeEntry[]
      | undefined,
    total: pages?.at(-1)?.total,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  }
}

/** Where a session's project folder is (so Everywhere can start there). */
export function useProjectRoot(project: ProjectSource | null) {
  return useQuery({
    queryKey: [...fileQueryKeys.all, 'root', project ? sourceKey(project) : ''],
    queryFn: () => fetchProjectRoot(project as ProjectSource),
    enabled: project !== null,
    staleTime: 60_000,
    retry: retryFiles,
  })
}

/** Home and the scratch folders, for the shortcuts. */
export function useFilePlaces() {
  return useQuery({
    queryKey: [...fileQueryKeys.all, 'places'],
    queryFn: fetchFilePlaces,
    staleTime: 60_000,
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
