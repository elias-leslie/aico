import { describe, expect, it, vi } from 'vitest'
import type { ATermHandle } from '@/components/a-term.types'
import { commitComposeInput } from './compose-input'

function handle() {
  return {
    status: 'connected',
    pasteInput: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn(),
  } as unknown as ATermHandle
}

describe('commitComposeInput', () => {
  it('uses the exact session and sends Enter only after its bracketed paste completes', async () => {
    let finishPaste: (() => void) | undefined
    const first = handle()
    const second = handle()
    first.pasteInput = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPaste = resolve
        }),
    )
    const handles = new Map([
      ['first', first],
      ['second', second],
    ])

    const result = commitComposeInput(handles, 'first', 'the ', 'send')
    expect(first.pasteInput).toHaveBeenCalledExactlyOnceWith('the ')
    expect(first.sendInput).not.toHaveBeenCalled()
    expect(second.pasteInput).not.toHaveBeenCalled()
    finishPaste?.()
    expect(await result).toBe(true)
    expect(first.sendInput).toHaveBeenCalledExactlyOnceWith('\r')
    expect(second.sendInput).not.toHaveBeenCalled()
  })

  it('keeps the draft when disconnected or when its pane is replaced', async () => {
    const first = handle()
    first.status = 'disconnected'
    const handles = new Map([['first', first]])
    expect(await commitComposeInput(handles, 'first', 'draft', 'send')).toBe(
      false,
    )
    expect(first.pasteInput).not.toHaveBeenCalled()

    first.status = 'connected'
    first.pasteInput = vi.fn().mockImplementation(async () => {
      handles.set('first', handle())
    })
    expect(await commitComposeInput(handles, 'first', 'draft', 'send')).toBe(
      false,
    )
    expect(first.sendInput).not.toHaveBeenCalled()
  })

  it('rejects multiline Send before writing to the terminal', async () => {
    const first = handle()
    expect(
      await commitComposeInput(
        new Map([['first', first]]),
        'first',
        'one\ntwo',
        'send',
      ),
    ).toBe(false)
    expect(first.pasteInput).not.toHaveBeenCalled()
  })
})
