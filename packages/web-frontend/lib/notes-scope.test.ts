import { describe, expect, it } from 'vitest'
import { newNoteHref, noteHref, notesHref, readScope } from './api/notes'

describe('notes scope in links', () => {
  it('carries the project and the widened list, and nothing without a project', () => {
    expect(notesHref()).toBe('/notes')
    expect(notesHref({ project: 'aico' })).toBe('/notes?project=aico')
    expect(notesHref({ project: 'aico', all: true })).toBe(
      '/notes?project=aico&scope=all',
    )
    expect(notesHref({ project: null, all: true })).toBe('/notes')
    expect(noteHref('abcdef012345', { project: 'aico' })).toBe(
      '/notes?id=abcdef012345&project=aico',
    )
    expect(newNoteHref('list', { project: 'aico' })).toBe(
      '/notes?new=list&project=aico',
    )
    expect(newNoteHref('note')).toBe('/notes?new=note')
  })

  it('reads it back, ignoring what is not a project id', () => {
    expect(readScope(new URLSearchParams('project=aico&scope=all'))).toEqual({
      project: 'aico',
      all: true,
    })
    expect(readScope(new URLSearchParams('project=../x'))).toEqual({
      project: null,
      all: false,
    })
    expect(readScope(new URLSearchParams(''))).toEqual({
      project: null,
      all: false,
    })
  })
})
