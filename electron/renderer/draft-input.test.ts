import { describe, expect, it } from 'vitest'
import { canSendDraft } from './draft-input'

describe('corrected draft sending', () => {
  it('allows only a nonempty single line in a TUI', () => {
    expect(canSendDraft('the corrected word', 'codex')).toBe(true)
    expect(canSendDraft('', 'codex')).toBe(false)
    expect(canSendDraft('the corrected word', 'shell')).toBe(false)
    expect(canSendDraft('one\ntwo', 'codex')).toBe(false)
    expect(canSendDraft('one\rtwo', 'codex')).toBe(false)
    expect(canSendDraft('one\u001btwo', 'codex')).toBe(false)
  })
})
