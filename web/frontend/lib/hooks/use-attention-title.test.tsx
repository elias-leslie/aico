import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAttentionTitle } from './use-session-attention'

function setHeadTitle(text: string) {
  let el = document.head.querySelector('title')
  if (!el) {
    el = document.createElement('title')
    document.head.appendChild(el)
  }
  el.textContent = text
}

describe('useAttentionTitle', () => {
  afterEach(() => setHeadTitle(''))

  it('keeps the needs-you count when the page title is re-rendered', async () => {
    setHeadTitle('A-Term')
    const { rerender, unmount } = renderHook(
      ({ count }) => useAttentionTitle(count),
      { initialProps: { count: 2 } },
    )
    expect(document.title).toBe('(2) A-Term')
    // Next re-renders its metadata <title>, dropping the prefix.
    setHeadTitle('A-Term')
    await waitFor(() => expect(document.title).toBe('(2) A-Term'))
    rerender({ count: 0 })
    expect(document.title).toBe('A-Term')
    unmount()
  })
})
