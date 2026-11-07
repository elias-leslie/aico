import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EmptySessionState } from './EmptySessionState'

const nav = vi.hoisted(() => ({ pathname: '/', query: '' }))

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.query),
}))
vi.mock('@/lib/frame/server-reach', () => ({
  useServerReach: () => ({ down: false }),
}))
vi.mock('@/lib/hooks/use-session-attention', () => ({
  useSessionAttention: () => undefined,
}))
vi.mock('@/lib/hooks/use-terminal-panes', () => ({
  usePaneListError: () => ({ isError: false, retry: () => undefined }),
}))
vi.mock('@/lib/chat', () => ({ newChat: () => undefined }))
vi.mock('./asks/NeedsYou', () => ({ NeedsYouLauncher: () => null }))
vi.mock('./capture/CaptureLauncher', () => ({ CaptureLauncher: () => null }))
vi.mock('./HostsButton', () => ({ HostsLauncher: () => null }))
vi.mock('./history/HistoryLauncher', () => ({ HistoryLauncher: () => null }))
vi.mock('./notes/NotesLauncher', () => ({ NotesLauncher: () => null }))
vi.mock('./SessionList', () => ({ SessionList: () => null }))
vi.mock('./status/StatusLauncher', () => ({ StatusLauncher: () => null }))

describe('EmptySessionState', () => {
  beforeEach(() => {
    nav.pathname = '/'
    nav.query = ''
  })

  it('says a linked session was not found only on the home link', () => {
    nav.query = 'session=abcd1234'
    render(<EmptySessionState slots={[]} />)
    expect(screen.getByText('Session not found.')).toBeInTheDocument()
  })

  it('does not call a past session opened in Recent "not found"', () => {
    nav.pathname = '/history'
    nav.query = 'session=claude-code%3Abeb34408'
    render(<EmptySessionState slots={[]} />)
    expect(screen.queryByText('Session not found.')).toBeNull()
    expect(screen.getByText('No session open.')).toBeInTheDocument()
  })
})
