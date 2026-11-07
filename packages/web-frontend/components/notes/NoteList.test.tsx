import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@/lib/api/notes'
import { NoteList } from './NoteList'

const api = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  fetchNoteLabels: vi.fn(),
}))
vi.mock('@/lib/api/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/notes')>()),
  ...api,
}))

const note = (id: string, over: Partial<NoteSummary> = {}): NoteSummary => ({
  id,
  kind: 'note',
  title: id,
  pinned: false,
  archived: false,
  source: null,
  createdAt: 1,
  editedAt: 1,
  updatedAt: 1,
  labels: [],
  unchecked: 0,
  checked: 0,
  remindAt: null,
  remindedAt: null,
  snippet: '',
  attachmentCount: 0,
  activityAt: 1,
  preview: [],
  ...over,
})

function renderList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <NoteList />
    </QueryClientProvider>,
  )
}

describe('NoteList reminders and labels', () => {
  beforeEach(() => {
    api.fetchNotes.mockReset()
    api.fetchNoteLabels.mockReset()
    api.fetchNoteLabels.mockResolvedValue([
      { label: 'Car', count: 1 },
      { label: 'Old label', count: 3 },
    ])
  })

  it('offers every label the server knows, not only those on the loaded notes', async () => {
    api.fetchNotes.mockResolvedValue({
      notes: [note('a', { labels: ['Car'] })],
      total: 1,
    })
    renderList()
    expect(
      await screen.findByRole('button', { name: 'Old label' }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Car' })).toBeTruthy()
  })

  it('falls back to the loaded notes when the label list cannot be read', async () => {
    api.fetchNoteLabels.mockRejectedValue(new Error('down'))
    api.fetchNotes.mockResolvedValue({
      notes: [note('a', { labels: ['Truck'] })],
      total: 1,
    })
    renderList()
    expect(await screen.findByRole('button', { name: 'Truck' })).toBeTruthy()
  })

  it('shows the due list in time order: what has come due, then what is coming', async () => {
    const past = Date.now() - 3_600_000
    const soon = Date.now() + 3_600_000
    api.fetchNotes.mockImplementation(async (query: { reminders?: boolean }) =>
      query.reminders
        ? {
            notes: [
              note('overdue', { remindAt: past, remindedAt: past + 60_000 }),
              note('later', { remindAt: soon }),
            ],
            total: 2,
          }
        : { notes: [], total: 0 },
    )
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Reminders' }))
    await waitFor(() =>
      expect(screen.getAllByTestId('note-card')).toHaveLength(2),
    )
    expect(api.fetchNotes).toHaveBeenLastCalledWith(
      expect.objectContaining({ reminders: true }),
    )
    expect(screen.getByRole('heading', { name: 'Due' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Coming up' })).toBeTruthy()
    expect(
      screen.getAllByTestId('note-card').map((card) => card.textContent),
    ).toEqual([
      expect.stringContaining('overdue'),
      expect.stringContaining('later'),
    ])
    expect(screen.getAllByTestId('note-due')).toHaveLength(2)
  })

  it('says so when there are no reminders', async () => {
    api.fetchNotes.mockResolvedValue({ notes: [], total: 0 })
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Reminders' }))
    expect((await screen.findByTestId('notes-empty')).textContent).toContain(
      'No reminders',
    )
  })
})
