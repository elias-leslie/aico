import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { offlineMessage, setOfflineForTest } from '@/lib/offline'
import { OfflineBanner, ReadOnlyScope } from './ReadOnly'

afterEach(() => act(() => setOfflineForTest({ offline: false, notesAt: null })))

function Page() {
  return (
    <>
      <OfflineBanner />
      <ReadOnlyScope>
        <button type="button">New note</button>
        <input aria-label="Title" />
      </ReadOnlyScope>
      <a href="/notes?id=abc">Open</a>
    </>
  )
}

describe('read-only while both hosts are offline', () => {
  it('shows nothing and leaves the controls on while a host answers', () => {
    render(<Page />)
    expect(screen.queryByTestId('offline-banner')).toBeNull()
    expect(screen.getByRole('button', { name: 'New note' })).toBeEnabled()
  })

  it('shows the banner, turns the controls off and keeps links working', () => {
    render(<Page />)
    act(() => setOfflineForTest({ offline: true, notesAt: Date.now() }))
    expect(screen.getByTestId('offline-banner').textContent).toMatch(
      /^Both hosts are offline\. Showing notes from .+\. Read-only\.$/,
    )
    expect(screen.getByRole('button', { name: 'New note' })).toBeDisabled()
    expect(screen.getByLabelText('Title')).toBeDisabled()
    expect(screen.getByRole('link', { name: 'Open' })).toBeVisible()
  })

  it('says so when nothing is saved on the device yet, and names the day for an older copy', () => {
    expect(offlineMessage({ offline: true, notesAt: null })).toBe(
      'Both hosts are offline. No notes are saved on this device yet. Read-only.',
    )
    const now = new Date(2026, 10, 3, 9, 0).getTime()
    const yesterday = new Date(2026, 10, 2, 22, 5).getTime()
    expect(offlineMessage({ offline: true, notesAt: yesterday }, now)).toMatch(
      /from \w{3} 10:05 PM\./,
    )
  })
})
