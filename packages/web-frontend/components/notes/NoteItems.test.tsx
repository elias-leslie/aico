// The checklist: Enter adds the next item, the struck hint checks in one tap,
// and a move lands between its new neighbours. The save status words.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type NoteDetail, type NoteItem, positionAt } from '@/lib/api/notes'
import { SaveStatus } from './NoteEditor'
import { type NoteActions, NoteItems } from './NoteItems'

vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => false }))

const item = (over: Partial<NoteItem> = {}): NoteItem => ({
  id: 'a1',
  noteId: 'n1',
  text: 'milk',
  checked: false,
  position: 1,
  hint: null,
  updatedAt: 1,
  ...over,
})

const note = (items: NoteItem[]): NoteDetail => ({
  id: 'n1',
  kind: 'list',
  title: 'Groceries',
  pinned: false,
  archived: false,
  source: null,
  project: null,
  createdAt: 1,
  editedAt: 1,
  updatedAt: 1,
  labels: [],
  unchecked: items.filter((x) => !x.checked).length,
  checked: items.filter((x) => x.checked).length,
  remindAt: null,
  remindedAt: null,
  body: '',
  items,
  attachments: [],
})

const actions = (over: Partial<NoteActions> = {}) =>
  ({
    add: vi.fn().mockResolvedValue(item()),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    ...over,
  }) as unknown as NoteActions

describe('NoteItems', () => {
  it('adds an item on Enter, in typed order, and clears the box for the next', async () => {
    const calls = actions()
    render(<NoteItems note={note([])} actions={calls} />)
    const box = screen.getByLabelText('Add an item')
    fireEvent.change(box, { target: { value: 'eggs' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box).toHaveValue('')
    fireEvent.change(box, { target: { value: 'bread' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(calls.add).toHaveBeenCalledTimes(2))
    expect((calls.add as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['eggs'],
      ['bread'],
    ])
  })

  it('puts the text back with the reason when an add fails', async () => {
    const calls = actions({
      add: vi.fn().mockRejectedValue(new Error('Server is down')),
    })
    render(<NoteItems note={note([])} actions={calls} />)
    const box = screen.getByLabelText('Add an item')
    fireEvent.change(box, { target: { value: 'eggs' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn\'t add "eggs": Server is down',
    )
    expect(box).toHaveValue('eggs')
  })

  it('asks if a struck line was crossed out on the photo, and checks it in one tap', () => {
    const calls = actions()
    const struck = item({ id: 'a2', text: 'butter', hint: 'struck' })
    render(<NoteItems note={note([item(), struck])} actions={calls} />)
    expect(screen.getAllByTestId('struck-hint')).toHaveLength(1)
    expect(screen.getByTestId('struck-hint')).toHaveTextContent(
      'Crossed out on the photo?',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }))
    expect(calls.setItem).toHaveBeenCalledWith(struck, { checked: true })
  })

  it('lists done items apart and clears them', async () => {
    const calls = actions()
    const done = item({ id: 'a3', text: 'tea', checked: true })
    render(<NoteItems note={note([item(), done])} actions={calls} />)
    expect(screen.getByText('Done · 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear checked' }))
    await waitFor(() => expect(calls.removeItem).toHaveBeenCalledWith(done))
  })
})

describe('positionAt', () => {
  it('lands between neighbours, or a step past either end', () => {
    expect(positionAt([1, 2, 4], 2)).toBe(3)
    expect(positionAt([1, 2], 0)).toBe(0)
    expect(positionAt([1, 2], 2)).toBe(3)
    expect(positionAt([], 0)).toBe(1)
  })
})

describe('SaveStatus', () => {
  it('says Saved, Saving… and a failure with Retry', () => {
    const retry = vi.fn()
    const { rerender } = render(<SaveStatus state="saved" onRetry={retry} />)
    expect(screen.getByTestId('note-save-state')).toHaveTextContent('Saved')
    rerender(<SaveStatus state="saving" onRetry={retry} />)
    expect(screen.getByTestId('note-save-state')).toHaveTextContent('Saving…')
    rerender(<SaveStatus state="error" onRetry={retry} />)
    expect(screen.getByTestId('note-save-state')).toHaveTextContent(
      "Couldn't save.",
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalled()
  })
})
