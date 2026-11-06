'use client'

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  fetchOverview,
  fetchProject,
  fetchTimeline,
  type PowerAction,
  postPower,
} from '../projects'

/** Places and counts move on their own; both reads refresh at these paces. */
const OVERVIEW_POLL_MS = 30_000
const DETAIL_POLL_MS = 15_000

export function useProjectOverview() {
  return useQuery({
    queryKey: ['projects', 'overview'],
    queryFn: fetchOverview,
    refetchInterval: OVERVIEW_POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  })
}

export function useProjectDetail(id: string) {
  return useQuery({
    queryKey: ['projects', 'detail', id],
    queryFn: () => fetchProject(id),
    refetchInterval: DETAIL_POLL_MS,
    retry: 1,
  })
}

/** Git days, newest first; each page asks for the commits before the last one shown. */
export function useProjectTimeline(id: string) {
  return useInfiniteQuery({
    queryKey: ['projects', 'timeline', id],
    queryFn: ({ pageParam }) => fetchTimeline(id, pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (page) => {
      if (page.end) return undefined
      const last = page.days.at(-1)?.commits.at(-1)
      return last?.sha
    },
    retry: 1,
  })
}

export function usePower(id: string, index: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (action: PowerAction) => postPower(id, index, action),
    onSettled: () => client.invalidateQueries({ queryKey: ['projects'] }),
  })
}
