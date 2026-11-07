'use client'

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useRef } from 'react'
import {
  addItem,
  deleteItem,
  deleteNote,
  fetchNote,
  fetchNotes,
  fetchRevisions,
  type NoteCreate,
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

/** Makes the note a New note screen stands for, once, the first time it gets
 * something in it. `seeded` says this call's content went into the new note. */
export type EnsureNote = (
  seed?: Partial<NoteCreate>,
) => Promise<{ id: string; seeded: boolean }>

/** The helpers an open note changes itself through: each writes the server's
 * answer straight into the cache, so the screen follows without waiting for a poll.
 * `id` is null on a New note not made yet: the first change makes it (`ensure`). */
export function useNoteActions(id: string | null, ensure?: EnsureNote) {
  const client = useQueryClient()
  const known = useRef(id)
  if (id) known.current = id
  const keyOf = (noteId: string) => [...NOTES_KEY, 'one', noteId]
  const target = async (): Promise<string> => {
    if (known.current) return known.current
    if (!ensure) throw new Error('That note is not made yet')
    known.current = (await ensure()).id
    return known.current
  }
  const refreshList = () =>
    client.invalidateQueries({ queryKey: [...NOTES_KEY, 'list'] })
  const edit = (noteId: string, change: (note: NoteDetail) => NoteDetail) =>
    client.setQueryData<NoteDetail>(keyOf(noteId), (note) =>
      note ? change(note) : note,
    )
  const settle = () => {
    if (!known.current) return
    void client.invalidateQueries({ queryKey: keyOf(known.current) })
    void refreshList()
  }

  return {
    /** Saves fields of the note; an older poll still in flight must not land over it. */
    async save(patch: NotePatch): Promise<NoteDetail | undefined> {
      if (!known.current && ensure) {
        const { keepRevision: _drop, ...content } = patch
        const made = await ensure(content)
        known.current = made.id
        if (made.seeded) return client.getQueryData<NoteDetail>(keyOf(made.id))
      }
      const noteId = await target()
      await client.cancelQueries({ queryKey: keyOf(noteId) })
      const saved = await patchNote(noteId, patch)
      client.setQueryData(keyOf(noteId), saved)
      void refreshList()
      return saved
    },
    async add(text: string) {
      const noteId = await target()
      const item = await addItem(noteId, text)
      edit(noteId, (note) => ({
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
      const noteId = await target()
      const key = keyOf(noteId)
      await client.cancelQueries({ queryKey: key })
      const before = client.getQueryData<NoteDetail>(key)
      // Shown at once; put back if the server refuses.
      edit(noteId, (note) => ({
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
        await patchItem(noteId, item.id, patch)
      } catch (error) {
        client.setQueryData(key, before)
        throw error
      } finally {
        settle()
      }
    },
    async removeItem(item: NoteItem) {
      const noteId = await target()
      await deleteItem(noteId, item.id)
      edit(noteId, (note) => ({
        ...note,
        items: note.items.filter((x) => x.id !== item.id),
        unchecked: note.unchecked - (item.checked ? 0 : 1),
        checked: note.checked - (item.checked ? 1 : 0),
      }))
      void refreshList()
    },
    async setLabels(labels: string[]) {
      if (!known.current && ensure) {
        const made = await ensure({ labels })
        known.current = made.id
        if (made.seeded) return
      }
      const noteId = await target()
      const saved = await putLabels(noteId, labels)
      edit(noteId, (note) => ({ ...note, labels: saved.labels }))
      void refreshList()
    },
    /** The note's id, making it first when it is a New note not made yet. */
    noteId: target,
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
