'use client'

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  addItem,
  deleteItem,
  deleteNote,
  fetchNote,
  fetchNotes,
  fetchRevisions,
  type NoteDetail,
  type NoteItem,
  type NotePatch,
  type NoteRevision,
  patchItem,
  patchNote,
  putLabels,
} from '../api/notes'
import { ApiError, isPermanentRefusal } from '../api-fetch'

export const NOTES_KEY = ['notes'] as const
/** As often as the captures list, so a change from another device shows up. */
const POLL_MS = 10_000

const retryOther = (count: number, error: unknown) =>
  !isPermanentRefusal(error) && count < 2

export function useNotes(q: string, archived: boolean) {
  const query = useQuery({
    queryKey: [...NOTES_KEY, 'list', q, archived],
    queryFn: ({ signal }) => fetchNotes({ q, archived, signal }),
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
  return {
    notes: query.data?.notes ?? [],
    total: query.data?.total ?? 0,
    loaded: query.data !== undefined,
    isLoading: query.isLoading,
    isError: query.isError && !query.data,
    isStale: query.isError && query.data !== undefined,
    error: query.error instanceof Error ? query.error.message : null,
    updatedAt: query.dataUpdatedAt,
    refetch: () => void query.refetch(),
  }
}

export function useNote(id: string | null) {
  const query = useQuery({
    queryKey: [...NOTES_KEY, 'one', id],
    queryFn: ({ signal }) => fetchNote(id as string, signal),
    enabled: id !== null,
    refetchInterval: POLL_MS,
    // Back from the other window (or another app): show its changes at once.
    refetchOnWindowFocus: true,
    retry: retryOther,
  })
  return {
    note: query.data ?? null,
    isLoading: query.isLoading,
    gone: query.error instanceof ApiError && query.error.status === 404,
    isError: query.isError && !query.data,
    isStale: query.isError && query.data !== undefined,
    error: query.error instanceof Error ? query.error.message : null,
    updatedAt: query.dataUpdatedAt,
    refetch: () => void query.refetch(),
  }
}

export function useNoteRevisions(id: string) {
  return useQuery({
    queryKey: [...NOTES_KEY, 'history', id],
    queryFn: async ({ signal }): Promise<NoteRevision[]> => {
      const [title, body] = await Promise.all([
        fetchRevisions(id, 'title', signal),
        fetchRevisions(id, 'body', signal),
      ])
      return [...title, ...body].sort((a, b) => b.savedAt - a.savedAt)
    },
    staleTime: 0,
    gcTime: 0,
  })
}

/** The helpers an open note changes itself through: each writes the server's
 * answer straight into the cache, so the screen follows without waiting for a poll. */
export function useNoteActions(id: string) {
  const client = useQueryClient()
  const key = [...NOTES_KEY, 'one', id]
  const refreshList = () =>
    client.invalidateQueries({ queryKey: [...NOTES_KEY, 'list'] })
  const edit = (change: (note: NoteDetail) => NoteDetail) =>
    client.setQueryData<NoteDetail>(key, (note) => (note ? change(note) : note))
  const settle = () => {
    void client.invalidateQueries({ queryKey: key })
    void refreshList()
  }

  return {
    /** Saves fields of the note; an older poll still in flight must not land over it. */
    async save(patch: NotePatch): Promise<NoteDetail> {
      await client.cancelQueries({ queryKey: key })
      const saved = await patchNote(id, patch)
      client.setQueryData(key, saved)
      void refreshList()
      return saved
    },
    async add(text: string) {
      const item = await addItem(id, text)
      edit((note) => ({
        ...note,
        items: [...note.items.filter((x) => x.id !== item.id), item],
        unchecked: note.unchecked + 1,
      }))
      void refreshList()
      return item
    },
    async setItem(
      item: NoteItem,
      patch: { text?: string; checked?: boolean; position?: number },
    ) {
      await client.cancelQueries({ queryKey: key })
      const before = client.getQueryData<NoteDetail>(key)
      // Shown at once; put back if the server refuses.
      edit((note) => ({
        ...note,
        items: note.items.map((x) =>
          x.id === item.id ? { ...x, ...patch } : x,
        ),
        ...(patch.checked !== undefined && patch.checked !== item.checked
          ? {
              unchecked: note.unchecked + (patch.checked ? -1 : 1),
              checked: note.checked + (patch.checked ? 1 : -1),
            }
          : {}),
      }))
      try {
        await patchItem(id, item.id, patch)
      } catch (error) {
        client.setQueryData(key, before)
        throw error
      } finally {
        settle()
      }
    },
    async removeItem(item: NoteItem) {
      await deleteItem(id, item.id)
      edit((note) => ({
        ...note,
        items: note.items.filter((x) => x.id !== item.id),
        unchecked: note.unchecked - (item.checked ? 0 : 1),
        checked: note.checked - (item.checked ? 1 : 0),
      }))
      void refreshList()
    },
    async setLabels(labels: string[]) {
      const saved = await putLabels(id, labels)
      edit((note) => ({ ...note, labels: saved.labels }))
      void refreshList()
    },
    refresh: settle,
  }
}

export function useDeleteNote() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteNote(id),
    onSuccess: (_none, id) => {
      client.removeQueries({ queryKey: [...NOTES_KEY, 'one', id] })
      void client.invalidateQueries({ queryKey: [...NOTES_KEY, 'list'] })
    },
  })
}
