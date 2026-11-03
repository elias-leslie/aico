import { describe, expect, it } from 'vitest'
import type { NoteDetail } from '@/lib/api/notes'
import { isBlankNote } from './NoteEditor'

const note = (over: Partial<NoteDetail> = {}): NoteDetail => ({
  id: 'abcdef012345',
  kind: 'note',
  title: '',
  pinned: false,
  archived: false,
  source: null,
  createdAt: 0,
  editedAt: 0,
  updatedAt: 0,
  labels: [],
  unchecked: 0,
  checked: 0,
  body: '',
  items: [],
  attachments: [],
  ...over,
})
const empty = { title: '', body: '' }

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
