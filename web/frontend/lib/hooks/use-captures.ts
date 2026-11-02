'use client'

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect } from 'react'
import {
  type Capture,
  type CapturePage,
  deleteCapture,
  fetchCapture,
  fetchCaptureLimits,
  fetchCaptures,
  retryCapture,
  saveCaption,
} from '../api/captures'
import { ApiError, isPermanentRefusal } from '../api-fetch'
import { setCaptureLimits } from '../capture-queue'

export const CAPTURES_KEY = ['captures'] as const
const LIMITS_KEY = ['capture-limits'] as const
const PAGE_SIZE = 30
/** As often as the session list, so a capture sent from another device shows up. */
const POLL_MS = 10_000

/** The server's file limits and accepted types, read once. */
export function useCaptureLimits() {
  const query = useQuery({
    queryKey: LIMITS_KEY,
    queryFn: ({ signal }) => fetchCaptureLimits(signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: (count, error) => !isPermanentRefusal(error) && count < 2,
  })
  useEffect(() => {
    setCaptureLimits(query.data ?? null)
  }, [query.data])
  return { limits: query.data ?? null, isError: query.isError }
}

/** Newest first, a page at a time. The first page refreshes on its own. */
export function useCaptures() {
  const query = useInfiniteQuery({
    queryKey: [...CAPTURES_KEY, 'list'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchCaptures({ before: pageParam, limit: PAGE_SIZE, signal }),
    getNextPageParam: (last: CapturePage, pages) => {
      const loaded = pages.reduce((n, page) => n + page.captures.length, 0)
      return last.captures.length > 0 && loaded < last.total
        ? last.captures[last.captures.length - 1].id
        : undefined
    },
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
  const pages = query.data?.pages
  return {
    captures: pages ? pages.flatMap((page) => page.captures) : [],
    total: pages?.[0]?.total ?? 0,
    loaded: pages !== undefined,
    isLoading: query.isLoading,
    /** The first load failed; nothing to show. */
    isError: query.isError && !pages,
    /** A refresh failed while an earlier list is on screen. */
    isStale: query.isError && pages !== undefined,
    error: query.error instanceof Error ? query.error.message : null,
    updatedAt: query.dataUpdatedAt,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    refetch: () => void query.refetch(),
  }
}

export function useCapture(id: string | null) {
  const query = useQuery({
    queryKey: [...CAPTURES_KEY, 'one', id],
    queryFn: ({ signal }) => fetchCapture(id as string, signal),
    enabled: id !== null,
    refetchInterval: POLL_MS,
    retry: (count, error) => !isPermanentRefusal(error) && count < 2,
  })
  return {
    capture: query.data ?? null,
    isLoading: query.isLoading,
    gone: query.error instanceof ApiError && query.error.status === 404,
    isError: query.isError && !query.data,
    isStale: query.isError && query.data !== undefined,
    error: query.error instanceof Error ? query.error.message : null,
    updatedAt: query.dataUpdatedAt,
    refetch: () => void query.refetch(),
  }
}

export function useSaveCaption() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, caption }: { id: string; caption: string }) =>
      saveCaption(id, caption),
    onSuccess: (capture: Capture) => {
      client.setQueryData([...CAPTURES_KEY, 'one', capture.id], capture)
      void client.invalidateQueries({ queryKey: [...CAPTURES_KEY, 'list'] })
    },
  })
}

export function useRetryCapture() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => retryCapture(id),
    onSuccess: (capture: Capture) => {
      client.setQueryData([...CAPTURES_KEY, 'one', capture.id], capture)
      void client.invalidateQueries({ queryKey: [...CAPTURES_KEY, 'list'] })
    },
  })
}

export function useDeleteCapture() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteCapture(id),
    onSuccess: (_none, id) => {
      client.removeQueries({ queryKey: [...CAPTURES_KEY, 'one', id] })
      void client.invalidateQueries({ queryKey: [...CAPTURES_KEY, 'list'] })
    },
  })
}

/** After files are sent, the list reloads to show them. */
export function useRefreshCaptures() {
  const client = useQueryClient()
  return () => client.invalidateQueries({ queryKey: [...CAPTURES_KEY, 'list'] })
}
