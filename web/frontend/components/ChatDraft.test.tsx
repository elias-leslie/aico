import { describe, expect, it, vi } from 'vitest'
import { mergeDraft, restoreDraft } from '../../../shared/chat/draft'

describe('putting follow-ups back in the message box', () => {
  it('puts the waiting texts ahead of what is already typed, a blank line apart', () => {
    expect(mergeDraft(['one', 'two'], '')).toBe('one\n\ntwo')
    expect(mergeDraft(['one'], 'typed')).toBe('one\n\ntyped')
    expect(mergeDraft(['one'], '   ')).toBe('one')
  })

  it('types them into the box so the chat component sees a change, and leaves the caret at the end', () => {
    const root = document.createElement('div')
    root.innerHTML = '<textarea></textarea>'
    document.body.append(root)
    const box = root.querySelector('textarea') as HTMLTextAreaElement
    const changed = vi.fn()
    box.addEventListener('input', () => changed(box.value))
    box.value = 'half a thought'
    expect(restoreDraft(root, ['first', 'second'])).toBe(true)
    expect(box.value).toBe('first\n\nsecond\n\nhalf a thought')
    expect(changed).toHaveBeenCalledWith('first\n\nsecond\n\nhalf a thought')
    expect(box.selectionStart).toBe(box.value.length)
    expect(document.activeElement).toBe(box)
    root.remove()
  })

  it('does nothing without a box or without text', () => {
    expect(restoreDraft(null, ['a'])).toBe(false)
    expect(restoreDraft(document.createElement('div'), ['a'])).toBe(false)
    const root = document.createElement('div')
    root.innerHTML = '<textarea>kept</textarea>'
    expect(restoreDraft(root, [])).toBe(false)
    expect(root.querySelector('textarea')?.value).toBe('kept')
  })
})
