/**
 * What a polled list or record tells the screen about its load: nothing to show yet (`isLoading`),
 * the first load failed (`isError`), or a refresh failed while an earlier copy is on screen
 * (`isStale`). `hasData` is whether a copy has been read.
 */
export function loadState(
  query: {
    isLoading: boolean
    isError: boolean
    error: unknown
    dataUpdatedAt: number
    refetch: () => unknown
  },
  hasData: boolean,
) {
  return {
    isLoading: query.isLoading,
    /** The first load failed; nothing to show. */
    isError: query.isError && !hasData,
    /** A refresh failed while an earlier copy is on screen. */
    isStale: query.isError && hasData,
    error: query.error instanceof Error ? query.error.message : null,
    updatedAt: query.dataUpdatedAt,
    refetch: () => void query.refetch(),
  }
}
