import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  markAnswered,
  markFailed,
  resetServerReachForTest,
} from '@/lib/frame/server-reach'
import { publishShownSession } from '@/lib/frame/shown-session'
import { COMPACT_TIER_STORAGE_KEY, TIER_STORAGE_KEY } from '@/lib/frame/tiers'
import { FrameProvider, useFrame } from './FrameContext'
import { LeftSide } from './LeftSide'

const nav = vi.hoisted(() => ({
  pathname: '/',
  push: vi.fn(),
  docked: true,
  roomy: true,
}))
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: nav.push }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: (query: string) =>
    query === '(min-width: 1024px)' ? nav.roomy : nav.docked,
}))
vi.mock('./SideList', () => ({
  SideList: () => <nav aria-label="Everything else">Side list</nav>,
}))
vi.mock('@tanstack/react-query', async (real) => ({
  ...(await real<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ refetchQueries: vi.fn() }),
}))

// jsdom has no PointerEvent; a mouse event carries what the handle reads.
beforeAll(() => {
  window.PointerEvent ??= class extends MouseEvent {} as typeof PointerEvent
})

function Probe() {
  const frame = useFrame()
  return (
    <>
      <output data-testid="tier">{frame?.tier}</output>
      <button type="button" onClick={() => frame?.setSheetOpen(true)}>
        Open sheet
      </button>
    </>
  )
}

function show(page: string | null = null) {
  return render(
    <FrameProvider page={page ? <p>{page} page</p> : null}>
      <Probe />
      <LeftSide
        onNewSession={vi.fn()}
        rail={<p>Rail marks</p>}
        panel={<p>Session list</p>}
        wideHome={<p>Status home</p>}
      />
      <input aria-label="Somewhere to type" />
    </FrameProvider>,
  )
}

const tier = () => screen.getByTestId('tier').textContent
const alt = (code: string) =>
  fireEvent.keyDown(window, { altKey: true, code, key: code })

beforeEach(() => {
  window.localStorage.clear()
  nav.pathname = '/'
  nav.docked = true
  nav.roomy = true
  nav.push.mockClear()
})
afterEach(() => resetServerReachForTest())

describe('the left side on a desktop', () => {
  it('a desktop window snapped narrow keeps the session with the rail, and remembers its own width', () => {
    window.localStorage.setItem(TIER_STORAGE_KEY, '"wide"')
    nav.roomy = false
    const first = show()
    expect(tier()).toBe('rail')
    expect(screen.getByText('Rail marks')).toBeVisible()
    expect(screen.queryByTestId('frame-sheet')).toBeNull()
    alt('Digit2')
    expect(tier()).toBe('panel')
    expect(window.localStorage.getItem(COMPACT_TIER_STORAGE_KEY)).toBe(
      '"panel"',
    )
    expect(window.localStorage.getItem(TIER_STORAGE_KEY)).toBe('"wide"')
    first.unmount()
    nav.roomy = true
    show()
    expect(tier()).toBe('wide')
  })

  it('opens at Panel and keeps the chosen width on this device, never Full', () => {
    const first = show()
    expect(tier()).toBe('panel')
    expect(screen.getByText('Session list')).toBeVisible()
    alt('Digit1')
    expect(tier()).toBe('rail')
    expect(screen.getByText('Rail marks')).toBeVisible()
    expect(window.localStorage.getItem(TIER_STORAGE_KEY)).toBe('"rail"')
    first.unmount()
    show()
    expect(tier()).toBe('rail')
  })

  it('steps with Alt+[ and Alt+], and Wide with no page shows the panel and Status', () => {
    show()
    alt('BracketRight')
    expect(tier()).toBe('wide')
    expect(screen.getByText('Session list')).toBeVisible()
    expect(screen.getByText('Status home')).toBeVisible()
    alt('BracketLeft')
    alt('BracketLeft')
    expect(tier()).toBe('rail')
    alt('BracketLeft')
    expect(tier()).toBe('hidden')
    expect(screen.queryByText('Rail marks')).toBeNull()
    expect(screen.queryByText('Session list')).toBeNull()
    expect(screen.getByTestId('frame-handle')).toBeInTheDocument()
    alt('BracketLeft')
    expect(tier()).toBe('hidden')
    alt('Digit1')
    expect(tier()).toBe('rail')
  })

  it('Full from home opens Status in place, and Esc comes back to Panel', () => {
    show()
    alt('Digit4')
    expect(tier()).toBe('full')
    expect(nav.push).toHaveBeenCalledWith('/status')
    // Esc while typing stays with the field.
    fireEvent.keyDown(screen.getByLabelText('Somewhere to type'), {
      key: 'Escape',
    })
    expect(tier()).toBe('full')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(tier()).toBe('panel')
  })

  it('a page link opens at Full with the side list; narrowing goes home', () => {
    nav.pathname = '/backups'
    show('Backups')
    expect(tier()).toBe('full')
    expect(screen.getByText('Side list')).toBeVisible()
    expect(screen.getByText('Backups page')).toBeVisible()
    fireEvent.click(screen.getByTestId('frame-close'))
    expect(tier()).toBe('panel')
    expect(nav.push).toHaveBeenCalledWith('/')
  })

  it('coming back from a page returns to the session that was on screen', () => {
    publishShownSession('s1')
    nav.pathname = '/grants'
    show('Grants')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(nav.push).toHaveBeenCalledWith('/?session=s1')
    publishShownSession(null)
  })

  it('the narrower and wider buttons step, and double-clicking the edge resets to Panel', () => {
    show()
    fireEvent.click(screen.getByTestId('frame-wider'))
    expect(tier()).toBe('wide')
    fireEvent.doubleClick(screen.getByTestId('frame-handle'))
    expect(tier()).toBe('panel')
    fireEvent.click(screen.getByTestId('frame-narrower'))
    expect(tier()).toBe('rail')
  })

  it('a drag snaps to the nearest width when let go, not before', () => {
    show()
    const handle = screen.getByTestId('frame-handle')
    fireEvent.pointerDown(handle, { button: 0, clientX: 360 })
    fireEvent.pointerMove(handle, { clientX: 900 })
    expect(tier()).toBe('panel')
    expect(screen.getByText('Wide')).toBeInTheDocument()
    expect(screen.getByTestId('snap-target')).toHaveTextContent(
      'Release for Wide',
    )
    fireEvent.pointerUp(handle, { clientX: 900 })
    expect(tier()).toBe('wide')
    expect(screen.queryByTestId('snap-target')).toBeNull()
  })

  it('names the width a drag in between will snap to', () => {
    show()
    const handle = screen.getByTestId('frame-handle')
    fireEvent.pointerDown(handle, { button: 0, clientX: 360 })
    fireEvent.pointerMove(handle, { clientX: 600 })
    expect(screen.getByTestId('snap-target')).toHaveTextContent(
      'Release for Panel',
    )
    fireEvent.pointerUp(handle, { clientX: 600 })
    expect(tier()).toBe('panel')
  })

  it('still works when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    show()
    alt('Digit3')
    expect(tier()).toBe('wide')
    vi.restoreAllMocks()
  })
})

describe('the left side on a phone', () => {
  beforeEach(() => {
    nav.docked = false
  })

  it('slides over the session from the menu and holds nothing while closed', () => {
    show()
    const sheet = screen.getByTestId('frame-sheet')
    expect(sheet).not.toHaveAttribute('data-open')
    expect(sheet).toHaveAttribute('inert')
    expect(screen.queryByText('Session list')).toBeNull()
    // The tier keys belong to the desktop.
    alt('Digit4')
    expect(tier()).toBe('panel')
    fireEvent.click(screen.getByRole('button', { name: 'Open sheet' }))
    expect(sheet).toHaveAttribute('data-open', 'true')
    expect(screen.getByText('Session list')).toBeVisible()
    fireEvent.click(screen.getByTestId('frame-close'))
    expect(sheet).not.toHaveAttribute('data-open')
  })

  it('opens a page full width with Back to the list', () => {
    nav.pathname = '/status'
    show('Status')
    expect(screen.getByTestId('frame-sheet')).toHaveAttribute(
      'data-open',
      'true',
    )
    expect(screen.getByText('Status page')).toBeVisible()
    fireEvent.click(screen.getByTestId('frame-back'))
    expect(nav.push).toHaveBeenCalledWith('/')
  })
})

describe('when the server cannot be reached', () => {
  it('keeps what it last knew and stops saying Loading sessions (the offline strip says why)', () => {
    const side = (
      <FrameProvider page={null}>
        <LeftSide
          loading
          onNewSession={vi.fn()}
          rail={null}
          panel={null}
          wideHome={null}
        />
      </FrameProvider>
    )
    render(side)
    expect(screen.getByText('Loading sessions…')).toBeVisible()
    act(() => markFailed(Date.now()))
    expect(screen.queryByText('Loading sessions…')).toBeNull()
    expect(screen.queryByTestId('side-down-note')).toBeNull()
    act(() => markAnswered())
  })
})
