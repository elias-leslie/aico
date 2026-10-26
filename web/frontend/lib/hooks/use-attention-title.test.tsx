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

  it('says how many need you, also when the page title is re-rendered', async () => {
    setHeadTitle('Aico')
    const { rerender, unmount } = renderHook(
      ({ count }) => useAttentionTitle(count),
      { initialProps: { count: 2 } },
    )
    expect(document.title).toBe('Aico · 2 need you')
    // Next re-renders its metadata <title>, dropping the suffix.
    setHeadTitle('Aico')
    await waitFor(() => expect(document.title).toBe('Aico · 2 need you'))
    rerender({ count: 1 })
    expect(document.title).toBe('Aico · 1 needs you')
    rerender({ count: 0 })
    expect(document.title).toBe('Aico')
    unmount()
  })
})
