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
import {
  COMPACT_TIER_STORAGE_KEY,
  PANEL_WIDTH_STORAGE_KEY,
  TIER_STORAGE_KEY,
} from '@/lib/frame/tiers'
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
      />
      <input aria-label="Somewhere to type" />
    </FrameProvider>,
  )
}

/** jsdom has no layout: the side is `width` wide when a drag starts, in a 1000px window. */
const sideWidth = (width: number) =>
  vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const side = this.dataset.testid === 'frame-side'
      return { width: side ? width : 1000, height: 0 } as DOMRect
    })

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
afterEach(() => {
  vi.restoreAllMocks()
  resetServerReachForTest()
})

describe('the left side on a desktop', () => {
  it('a desktop window snapped narrow keeps the session with the rail, and remembers its own width', () => {
    window.localStorage.setItem(TIER_STORAGE_KEY, '"panel"')
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
    expect(window.localStorage.getItem(TIER_STORAGE_KEY)).toBe('"panel"')
    first.unmount()
    nav.roomy = true
    show()
    expect(tier()).toBe('panel')
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

  it('an old hidden side opens as the panel, as there is no hidden any more', () => {
    window.localStorage.setItem(TIER_STORAGE_KEY, '"hidden"')
    show()
    expect(tier()).toBe('panel')
    expect(screen.getByText('Session list')).toBeVisible()
  })

  it('Alt+[ and Alt+] flip between the panel and the rail, and there is no Full by key', () => {
    show()
    alt('BracketRight')
    expect(tier()).toBe('rail')
    alt('BracketLeft')
    expect(tier()).toBe('panel')
    alt('Digit1')
    expect(tier()).toBe('rail')
    alt('Digit0')
    alt('Digit3')
    alt('Digit4')
    expect(tier()).toBe('rail')
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('has one toggle at the top left of the rail and of the panel, and no arrows', () => {
    show()
    const toggle = screen.getByTestId('frame-toggle')
    expect(toggle).toHaveAccessibleName('Collapse the side')
    expect(toggle).toHaveAttribute('title', 'Collapse the side · Alt+[')
    expect(screen.getAllByRole('button', { name: /side$/ })).toHaveLength(1)
    expect(screen.queryByTestId('frame-narrower')).toBeNull()
    expect(screen.queryByTestId('frame-wider')).toBeNull()
    fireEvent.click(toggle)
    expect(tier()).toBe('rail')
    expect(screen.getByText('Rail marks')).toBeVisible()
    const again = screen.getByTestId('frame-toggle')
    expect(again).toHaveAccessibleName('Expand the side')
    expect(screen.getAllByRole('button', { name: /side$/ })).toHaveLength(1)
    fireEvent.click(again)
    expect(tier()).toBe('panel')
  })

  it('Esc leaves a page for the session while typing stays with the field', () => {
    nav.pathname = '/status'
    show('Status')
    expect(tier()).toBe('full')
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
    nav.pathname = '/status'
    show('Status')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(nav.push).toHaveBeenCalledWith('/?session=s1')
    publishShownSession(null)
  })

  it('a Settings path is a dialog over the session, not a page on the left side', () => {
    nav.pathname = '/logins'
    show('Logins')
    expect(tier()).toBe('panel')
    expect(screen.queryByText('Logins page')).toBeNull()
  })

  it('opening a setup place from the side only changes the address', () => {
    function Opener() {
      const frame = useFrame()
      return (
        <button type="button" onClick={() => frame?.open('/grants?request=n1')}>
          Open grants
        </button>
      )
    }
    render(
      <FrameProvider page={null}>
        <Opener />
        <Probe />
      </FrameProvider>,
    )
    fireEvent.click(screen.getByText('Open grants'))
    expect(nav.push).toHaveBeenCalledWith('/grants?request=n1')
    expect(tier()).toBe('panel')
  })

  it('double-clicking the edge resets to the default Panel', () => {
    window.localStorage.setItem(TIER_STORAGE_KEY, '"rail"')
    show()
    fireEvent.doubleClick(screen.getByTestId('frame-handle'))
    expect(tier()).toBe('panel')
  })

  it('a drag in lands on the rail when let go, not before', () => {
    sideWidth(360)
    show()
    const handle = screen.getByTestId('frame-handle')
    fireEvent.pointerDown(handle, { button: 0, clientX: 360 })
    fireEvent.pointerMove(handle, { clientX: 100 })
    expect(tier()).toBe('panel')
    expect(screen.getByTestId('snap-target')).toHaveTextContent(
      'Release for the rail',
    )
    fireEvent.pointerUp(handle, { clientX: 100 })
    expect(tier()).toBe('rail')
    expect(screen.queryByTestId('snap-target')).toBeNull()
  })

  it('a drag out sets the panel wider, kept on this device, and the edge resets it', () => {
    sideWidth(360)
    show()
    const handle = screen.getByTestId('frame-handle')
    fireEvent.pointerDown(handle, { button: 0, clientX: 360 })
    fireEvent.pointerMove(handle, { clientX: 520 })
    expect(screen.getByTestId('snap-target')).toHaveTextContent(
      'Release for a 520px panel',
    )
    fireEvent.pointerUp(handle, { clientX: 520 })
    expect(tier()).toBe('panel')
    expect(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe('520')
    expect(screen.getByTestId('frame-side').style.width).toBe('520px')
    fireEvent.doubleClick(screen.getByTestId('frame-handle'))
    expect(screen.getByTestId('frame-side').style.width).toBe('360px')
  })

  it('still works when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    show()
    alt('Digit1')
    expect(tier()).toBe('rail')
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
        <LeftSide loading onNewSession={vi.fn()} rail={null} panel={null} />
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
