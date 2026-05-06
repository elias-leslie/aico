import { describe, expect, it, vi } from 'vitest'
import { setupFocusAndPasteTracking } from './a-term-instance-utils'

function dispatchPaste(
  textarea: HTMLTextAreaElement,
  clipboardData: Partial<DataTransfer>,
) {
  const event = new Event('paste', {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: clipboardData,
  })
  const stopImmediatePropagation = vi.spyOn(event, 'stopImmediatePropagation')

  textarea.dispatchEvent(event)

  return { event, stopImmediatePropagation }
}

describe('setupFocusAndPasteTracking', () => {
  it('captures clipboard images before they fall through to terminal input', () => {
    const textarea = document.createElement('textarea')
    const isFocusedRef = { current: false }
    const onPaste = vi.fn()
    const onFilePaste = vi.fn()
    const image = new File(['image'], 'pasted.png', { type: 'image/png' })

    const cleanup = setupFocusAndPasteTracking(
      textarea,
      isFocusedRef,
      onPaste,
      onFilePaste,
    )
    const { event, stopImmediatePropagation } = dispatchPaste(textarea, {
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => image,
        },
      ] as unknown as DataTransferItemList,
      files: [] as unknown as FileList,
      getData: vi.fn(),
    })

    expect(event.defaultPrevented).toBe(true)
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(onFilePaste).toHaveBeenCalledWith(image)
    expect(onPaste).not.toHaveBeenCalled()

    cleanup.focusCleanup()
    cleanup.pasteCleanup()
  })

  it('keeps text paste on the bracketed paste path', () => {
    const textarea = document.createElement('textarea')
    const isFocusedRef = { current: false }
    const onPaste = vi.fn()
    const onFilePaste = vi.fn()

    const cleanup = setupFocusAndPasteTracking(
      textarea,
      isFocusedRef,
      onPaste,
      onFilePaste,
    )
    const getData = vi.fn((type: string) => (type === 'text' ? 'hello' : ''))
    const { event, stopImmediatePropagation } = dispatchPaste(textarea, {
      items: [] as unknown as DataTransferItemList,
      files: [] as unknown as FileList,
      getData,
    })

    expect(event.defaultPrevented).toBe(true)
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(onPaste).toHaveBeenCalledWith('hello')
    expect(onFilePaste).not.toHaveBeenCalled()

    cleanup.focusCleanup()
    cleanup.pasteCleanup()
  })
})
