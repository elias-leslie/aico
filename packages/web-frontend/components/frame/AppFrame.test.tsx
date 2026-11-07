import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppFrame } from './AppFrame'

const nav = vi.hoisted(() => ({
  pathname: '/',
  params: new URLSearchParams(),
}))
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => true }))
const asks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/lib/frame/needs-you-request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/frame/needs-you-request')>()),
  openNeedsYou: asks.open,
}))
vi.mock('./OfflineStrip', () => ({
  OfflineStrip: () => <p>Offline strip</p>,
}))
vi.mock('../TerminalTabs', () => ({
  TerminalTabs: ({
    projectId,
    projectPath,
  }: {
    projectId?: string
    projectPath?: string
  }) => (
    <div
      data-testid="terminal-tabs"
      data-project-id={projectId ?? ''}
      data-project-path={projectPath ?? ''}
    />
  ),
}))

const show = (path: string) => {
  const [pathname, query = ''] = path.split('?')
  nav.pathname = pathname ?? '/'
  nav.params = new URLSearchParams(query)
  return render(
    <AppFrame>
      <p>The page</p>
    </AppFrame>,
  )
}

describe('AppFrame', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
    asks.open.mockClear()
  })

  it('carries the offline strip over the side and the session', () => {
    show('/')
    expect(screen.getByText('Offline strip')).toBeInTheDocument()
  })

  it('opens Needs you on a push link’s question once, then drops it from the address', () => {
    window.history.replaceState(null, '', '/?ask=0123456789ab&keep=1')
    show('/')
    expect(asks.open).toHaveBeenCalledTimes(1)
    expect(asks.open).toHaveBeenCalledWith('0123456789ab')
    expect(window.location.search).toBe('?keep=1')
  })

  it('ignores a push link that is not a question id', () => {
    window.history.replaceState(null, '', '/?ask=nope')
    show('/')
    expect(asks.open).not.toHaveBeenCalled()
  })

  it('opens or starts a project session from a home link, first non-empty value', () => {
    show('/?project=&project=portfolio-ai&dir=&dir=/home/demo/portfolio-ai')
    const tabs = screen.getByTestId('terminal-tabs')
    expect(tabs).toHaveAttribute('data-project-id', 'portfolio-ai')
    expect(tabs).toHaveAttribute('data-project-path', '/home/demo/portfolio-ai')
  })

  it('leaves a page’s own query to the page (/status?project=)', () => {
    show('/status?project=aico')
    expect(screen.getByTestId('terminal-tabs')).toHaveAttribute(
      'data-project-id',
      '',
    )
  })

  it('lets the popped-out notes window stand alone, without the frame', () => {
    show('/notes?new=note')
    expect(screen.getByText('The page')).toBeInTheDocument()
    expect(screen.queryByTestId('app-frame')).toBeNull()
    expect(screen.queryByTestId('terminal-tabs')).toBeNull()
  })
})
