import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteDetail, NoteSummary, NotesScope } from '@/lib/api/notes'
import { NoteEditor } from './NoteEditor'
import { NoteList } from './NoteList'

const api = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  fetchNoteLabels: vi.fn(),
  fetchNote: vi.fn(),
  patchNote: vi.fn(),
}))
vi.mock('@/lib/api/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/notes')>()),
  ...api,
}))
vi.mock('@/lib/hooks/use-note-projects', () => ({
  useNoteProjects: () => ({
    projects: [
      { id: 'portfolio-ai', name: 'Portfolio' },
      { id: 'aico', name: 'Aico' },
    ],
    loaded: true,
    nameOf: (id: string) =>
      ({ 'portfolio-ai': 'Portfolio', aico: 'Aico' })[id] ?? id,
  }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => true }))
vi.mock('@/lib/hooks/use-captures', () => ({
  useCaptureLimits: () => ({ limits: null }),
}))

const summary = (id: string, over: Partial<NoteSummary> = {}): NoteSummary => ({
  id,
  kind: 'note',
  title: id,
  pinned: false,
  archived: false,
  source: null,
  project: null,
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

const detail = (over: Partial<NoteDetail> = {}): NoteDetail => ({
  ...summary('abcdef012345'),
  body: '',
  items: [],
  attachments: [],
  ...over,
})

const wrap = (node: React.ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  )
}

describe('NoteList scope', () => {
  beforeEach(() => {
    api.fetchNotes.mockReset()
    api.fetchNoteLabels.mockReset()
    api.fetchNoteLabels.mockResolvedValue([])
  })

  it('opens on the session project, says so, and widens to All in one click', async () => {
    api.fetchNotes.mockImplementation(async (query: { project?: string }) =>
      query.project
        ? { notes: [summary('mine', { project: 'portfolio-ai' })], total: 1 }
        : {
            notes: [
              summary('mine', { project: 'portfolio-ai' }),
              summary('loose'),
              summary('other', { project: 'aico' }),
            ],
            total: 3,
          },
    )
    const onScope = vi.fn()
    const scope: NotesScope = { project: 'portfolio-ai', all: false }
    const view = wrap(<NoteList scope={scope} onScope={onScope} />)
    await waitFor(() =>
      expect(screen.getAllByTestId('note-card')).toHaveLength(1),
    )
    expect(api.fetchNotes).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: 'portfolio-ai' }),
    )
    const group = screen.getByRole('group', { name: 'Notes shown' })
    expect(
      screen
        .getByRole('button', { name: 'Portfolio' })
        .getAttribute('aria-pressed'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'All notes' }))
    expect(onScope).toHaveBeenCalledWith(true)
    expect(group).toBeTruthy()

    // All: every note, each project's notes named, global ones unnamed.
    view.unmount()
    wrap(<NoteList scope={{ ...scope, all: true }} onScope={onScope} />)
    await waitFor(() =>
      expect(screen.getAllByTestId('note-card')).toHaveLength(3),
    )
    expect(api.fetchNotes).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: undefined }),
    )
    expect(
      screen.getAllByTestId('note-project').map((tag) => tag.textContent),
    ).toEqual(['Portfolio', 'Aico'])
    expect(
      screen
        .getByRole('button', { name: 'All notes' })
        .getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('with no session open shows All, and says so', async () => {
    api.fetchNotes.mockResolvedValue({ notes: [summary('a')], total: 1 })
    wrap(<NoteList />)
    await waitFor(() =>
      expect(screen.getAllByTestId('note-card')).toHaveLength(1),
    )
    expect(screen.getByTestId('notes-scope').textContent).toBe(
      'Showing all notes',
    )
    expect(api.fetchNotes).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: undefined }),
    )
  })

  it('an empty project says so by name and offers All', async () => {
    api.fetchNotes.mockResolvedValue({ notes: [], total: 0 })
    const onScope = vi.fn()
    wrap(
      <NoteList
        scope={{ project: 'portfolio-ai', all: false }}
        onScope={onScope}
      />,
    )
    const empty = await screen.findByTestId('notes-empty')
    expect(empty.textContent).toContain('No notes in Portfolio yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Show all notes' }))
    expect(onScope).toHaveBeenCalledWith(true)
  })
})

describe('Note project', () => {
  beforeEach(() => {
    api.fetchNote.mockReset()
    api.patchNote.mockReset()
  })

  it('moves a note to another project, and to none', async () => {
    api.fetchNote.mockResolvedValue(detail({ project: 'aico' }))
    api.patchNote.mockImplementation(async (_id, patch) =>
      detail({ project: 'aico', ...patch }),
    )
    wrap(<NoteEditor id="abcdef012345" />)
    const picker = (await screen.findByLabelText(
      'Project',
    )) as HTMLSelectElement
    expect(picker.value).toBe('aico')
    fireEvent.change(picker, { target: { value: 'portfolio-ai' } })
    await waitFor(() =>
      expect(api.patchNote).toHaveBeenLastCalledWith('abcdef012345', {
        project: 'portfolio-ai',
      }),
    )
    await waitFor(() => expect(picker.value).toBe('portfolio-ai'))
    fireEvent.change(picker, { target: { value: '' } })
    await waitFor(() =>
      expect(api.patchNote).toHaveBeenLastCalledWith('abcdef012345', {
        project: null,
      }),
    )
    await waitFor(() => expect(picker.value).toBe(''))
  })

  it('keeps a project the registry no longer lists', async () => {
    api.fetchNote.mockResolvedValue(detail({ project: 'retired' }))
    wrap(<NoteEditor id="abcdef012345" />)
    const picker = (await screen.findByLabelText(
      'Project',
    )) as HTMLSelectElement
    expect(picker.value).toBe('retired')
  })
})
