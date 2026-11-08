import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteDetail } from '@/lib/api/notes'
import { deleteWarning, isBlankNote, NoteEditor } from './NoteEditor'

const note = (over: Partial<NoteDetail> = {}): NoteDetail => ({
  id: 'abcdef012345',
  kind: 'note',
  title: '',
  pinned: false,
  archived: false,
  source: null,
  project: null,
  createdAt: 0,
  editedAt: 0,
  updatedAt: 0,
  labels: [],
  unchecked: 0,
  checked: 0,
  remindAt: null,
  remindedAt: null,
  body: '',
  items: [],
  attachments: [],
  ...over,
})
const empty = { title: '', body: '' }

describe('deleteWarning', () => {
  it('names only what this note has', () => {
    expect(deleteWarning(note({ title: 'Plan' }))).toBe(
      'Plan will be removed and can’t be brought back.',
    )
    expect(
      deleteWarning(
        note({
          title: 'Shop',
          items: [{}, {}] as NoteDetail['items'],
          attachments: [{ captureId: 'c1' }] as NoteDetail['attachments'],
        }),
      ),
    ).toBe(
      'Shop will be removed, with its 2 items, and can’t be brought back. Photos and files from Captures stay there.',
    )
    expect(
      deleteWarning(
        note({
          title: 'Trip',
          items: [{}] as NoteDetail['items'],
          attachments: [
            { captureId: null },
            { captureId: null },
            { captureId: 'c1' },
          ] as NoteDetail['attachments'],
        }),
      ),
    ).toBe(
      'Trip will be removed, with its item and its 2 files, and can’t be brought back. Photos and files from Captures stay there.',
    )
  })
})

describe('isBlankNote', () => {
  it('is blank with nothing in it', () => {
    expect(isBlankNote(note(), { title: ' ', body: '\n' })).toBe(true)
  })
  it('keeps a note with unsaved typing', () => {
    expect(isBlankNote(note(), { title: '', body: 'milk' })).toBe(false)
  })
  it('keeps Groceries and anything with items, photos, labels or a pin', () => {
    expect(isBlankNote(note({ source: 'aico:groceries' }), empty)).toBe(false)
    expect(
      isBlankNote(note({ items: [{} as NoteDetail['items'][number]] }), empty),
    ).toBe(false)
    expect(
      isBlankNote(
        note({ attachments: [{} as NoteDetail['attachments'][number]] }),
        empty,
      ),
    ).toBe(false)
    expect(isBlankNote(note({ labels: ['truck'] }), empty)).toBe(false)
    expect(isBlankNote(note({ pinned: true }), empty)).toBe(false)
  })
})

// A New note: nothing is saved until something is put in it.

const api = vi.hoisted(() => ({
  createNote: vi.fn(),
  patchNote: vi.fn(),
  putLabels: vi.fn(),
}))
vi.mock('@/lib/api/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/notes')>()),
  ...api,
  // The note just made is re-read from the server: it has what was saved.
  fetchNote: vi.fn(() => new Promise(() => {})),
}))
vi.mock('@/lib/hooks/use-note-projects', () => ({
  useNoteProjects: () => ({
    projects: [
      { id: 'portfolio-ai', name: 'Portfolio' },
      { id: 'aico', name: 'Aico' },
    ],
    loaded: true,
    nameOf: (id: string) => (id === 'portfolio-ai' ? 'Portfolio' : id),
  }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => true }))
vi.mock('@/lib/hooks/use-captures', () => ({
  useCaptureLimits: () => ({ limits: null }),
}))

function renderNew(onMade = vi.fn(), project: string | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <NoteEditor id={null} kind="note" project={project} onMade={onMade} />
    </QueryClientProvider>,
  )
  return { ...view, onMade }
}

describe('New note', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.createNote.mockReset()
    api.patchNote.mockReset()
    api.putLabels.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('opens ready to type and saves nothing when left empty', async () => {
    const { unmount } = renderNew()
    expect(document.activeElement).toBe(screen.getByLabelText('Title'))
    expect(screen.getByTestId('note-save-state').textContent).toBe(
      'Saves once you type',
    )
    expect(screen.queryByLabelText('Delete')).toBeNull()
    // Choosing List is not content either.
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    unmount()
    await vi.runAllTimersAsync()
    expect(api.createNote).not.toHaveBeenCalled()
  })

  it('is made once, with what was typed, on the first save', async () => {
    api.createNote.mockImplementation(async (input) =>
      note({ id: 'f00dfeed0001', ...input }),
    )
    api.patchNote.mockImplementation(async (id, patch) =>
      note({ id, title: 'Pay rent', ...patch }),
    )
    const { onMade } = renderNew()
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Pay rent' },
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.createNote).toHaveBeenCalledTimes(1)
    expect(api.createNote).toHaveBeenCalledWith({
      kind: 'note',
      title: 'Pay rent',
    })
    await waitFor(() => expect(onMade).toHaveBeenCalledWith('f00dfeed0001'))
    // Typing goes on in the same box and saves to the note just made.
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Pay rent today' },
    })
    await vi.advanceTimersByTimeAsync(1000)
    await waitFor(() =>
      expect(api.patchNote).toHaveBeenCalledWith('f00dfeed0001', {
        title: 'Pay rent today',
      }),
    )
    expect(api.createNote).toHaveBeenCalledTimes(1)
  })

  it('a label makes it too', async () => {
    api.createNote.mockImplementation(async (input) =>
      note({ id: 'f00dfeed0002', ...input }),
    )
    renderNew()
    const box = screen.getByLabelText('Add a label')
    fireEvent.change(box, { target: { value: 'truck' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() =>
      expect(api.createNote).toHaveBeenCalledWith({
        kind: 'note',
        labels: ['truck'],
      }),
    )
    expect(api.putLabels).not.toHaveBeenCalled()
  })

  it('a reminder makes it too, and a note holding only a reminder is not blank', async () => {
    api.createNote.mockImplementation(async (input) =>
      note({ id: 'f00dfeed0003', ...input }),
    )
    renderNew()
    fireEvent.click(screen.getByTestId('note-remind'))
    fireEvent.change(screen.getByLabelText('Reminder time'), {
      target: { value: '2030-01-15T09:30' },
    })
    await waitFor(() =>
      expect(api.createNote).toHaveBeenCalledWith({
        kind: 'note',
        remindAt: new Date(2030, 0, 15, 9, 30).getTime(),
      }),
    )
    expect(isBlankNote(note({ remindAt: 5 }), empty)).toBe(false)
  })

  it('starts in the project Notes was opened for, which can be changed before anything is typed', async () => {
    api.createNote.mockImplementation(async (input) =>
      note({ id: 'f00dfeed0004', ...input }),
    )
    renderNew(vi.fn(), 'portfolio-ai')
    const picker = screen.getByLabelText('Project') as HTMLSelectElement
    expect(picker.value).toBe('portfolio-ai')
    // Choosing a project is not content: nothing is made yet.
    fireEvent.change(picker, { target: { value: 'aico' } })
    expect(api.createNote).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Plan' },
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.createNote).toHaveBeenCalledWith({
      kind: 'note',
      title: 'Plan',
      project: 'aico',
    })
  })

  it('a note with no session behind it starts with no project', async () => {
    api.createNote.mockImplementation(async (input) =>
      note({ id: 'f00dfeed0005', ...input }),
    )
    renderNew()
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe(
      '',
    )
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Loose' },
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.createNote).toHaveBeenCalledWith({
      kind: 'note',
      title: 'Loose',
    })
  })
})
