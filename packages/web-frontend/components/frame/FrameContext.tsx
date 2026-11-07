'use client'

import { usePathname, useRouter } from 'next/navigation'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNeedsYouRequests } from '@/lib/frame/needs-you-request'
import { homeHref } from '@/lib/frame/shown-session'
import {
  DEFAULT_TIER,
  type DockedTier,
  isDocked,
  stepTier,
  TIER_STORAGE_KEY,
  type Tier,
  tierKey,
} from '@/lib/frame/tiers'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import { useMediaQuery } from '@/lib/hooks/use-media-query'

/** Wide enough for the left side beside a readable session; narrower windows
 * slide it over the session, as a phone does. */
const DOCKED_QUERY = '(min-width: 1024px)'
/** Where Full opens when no page is chosen yet. */
const DEFAULT_FULL_PAGE = '/status'

export interface Frame {
  /** The routed page (Status, Projects, ...) shown on the left side, or null at home. */
  page: ReactNode
  pathname: string
  /** The left side sits beside the session (desktop); otherwise it slides over it. */
  docked: boolean
  tier: Tier
  setTier: (tier: Tier) => void
  step: (direction: -1 | 1) => void
  /** Narrow windows: the left side is slid over the session. */
  sheetOpen: boolean
  setSheetOpen: (open: boolean) => void
  /** Show a page on the left side: Full by default, or Wide beside the session. */
  open: (href: string, tier?: 'wide' | 'full') => void
  /** Back to the session: Panel (desktop) or the sheet closed (narrow). */
  close: () => void
  /** Back from a page to the side's own list (the phone sheet's Back). */
  home: () => void
}

const FrameContext = createContext<Frame | null>(null)

/** The frame, or null outside one (tests, the popped-out notes window). */
export function useFrame(): Frame | null {
  return useContext(FrameContext)
}

/** Whether a dialog sits over the page: Esc is then the dialog's. */
function dialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [aria-modal="true"]')
}

function inSession(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.xterm')
}

function typingIn(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  )
}

export function FrameProvider({
  page,
  children,
}: {
  page: ReactNode
  children: ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname() ?? '/'
  const onPage = pathname !== '/'
  const docked = useMediaQuery(DOCKED_QUERY)
  const [stored, setStored] = useLocalStorageState<DockedTier>(
    TIER_STORAGE_KEY,
    DEFAULT_TIER,
  )
  const kept: DockedTier = isDocked(stored) ? stored : DEFAULT_TIER
  // Full is never kept: a reload opens on the session, not over it. A page
  // opened by its link (/status) shows Full.
  const [full, setFull] = useState(onPage)
  const [sheetOpen, setSheetOpen] = useState(onPage)
  const tier: Tier = full ? 'full' : kept

  // A page link opens the page where it can be seen: Full beside a narrow
  // side, the open sheet on a phone. Home again (Back) leaves Full.
  const lastPath = useRef(pathname)
  useEffect(() => {
    if (lastPath.current === pathname) return
    lastPath.current = pathname
    if (onPage) {
      if (kept !== 'wide') setFull(true)
      setSheetOpen(true)
    } else setFull(false)
  }, [pathname, onPage, kept])

  const setTier = useCallback(
    (next: Tier) => {
      if (next === 'full') {
        setFull(true)
        if (!onPage) router.push(DEFAULT_FULL_PAGE)
        return
      }
      setFull(false)
      setStored(next)
      // Only Wide and Full have room for a page; the narrower ones go home.
      if (onPage && next !== 'wide') router.push(homeHref())
    },
    [onPage, router, setStored],
  )
  const step = useCallback(
    (direction: -1 | 1) => setTier(stepTier(tier, direction)),
    [setTier, tier],
  )
  const open = useCallback(
    (href: string, where: 'wide' | 'full' = 'full') => {
      if (where === 'wide') {
        setFull(false)
        setStored('wide')
      } else setFull(true)
      setSheetOpen(true)
      if (href !== pathname + (window.location.search || '')) router.push(href)
    },
    [pathname, router, setStored],
  )
  const close = useCallback(() => {
    if (docked) setTier('panel')
    else {
      setSheetOpen(false)
      if (onPage) router.push(homeHref())
    }
  }, [docked, onPage, router, setTier])
  const home = useCallback(() => {
    if (onPage) router.push(homeHref())
  }, [onPage, router])

  // Needs you was asked for (a count, a push link, a session's own question):
  // bring the side's list to the front, wide enough to show it.
  useNeedsYouRequests(
    () => {
      if (onPage) router.push(homeHref())
      if (!docked) setSheetOpen(true)
      else {
        setFull(false)
        if (kept === 'rail') setStored('panel')
      }
    },
    { replay: false },
  )

  // The keys: Alt+1..4 and Alt+[ / Alt+] anywhere, even while typing in a
  // session (caught before the session sees them); Esc back to Panel from
  // Full, or from Wide while working on the left side.
  useEffect(() => {
    if (!docked) return
    const onKeyDown = (event: KeyboardEvent) => {
      const key = tierKey(event)
      if (!key) return
      event.preventDefault()
      event.stopPropagation()
      if ('tier' in key) setTier(key.tier)
      else step(key.step)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (tier !== 'full' && tier !== 'wide') return
      if (dialogOpen() || inSession(event.target) || typingIn(event.target))
        return
      const side = document.querySelector('[data-frame-side]')
      if (tier === 'wide' && !side?.contains(document.activeElement)) return
      event.preventDefault()
      setTier('panel')
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keydown', onEscape)
    }
  }, [docked, setTier, step, tier])

  const value = useMemo<Frame>(
    () => ({
      page: onPage ? page : null,
      pathname,
      docked,
      tier,
      setTier,
      step,
      sheetOpen,
      setSheetOpen,
      open,
      close,
      home,
    }),
    [
      onPage,
      page,
      pathname,
      docked,
      tier,
      setTier,
      step,
      sheetOpen,
      open,
      close,
      home,
    ],
  )
  return <FrameContext.Provider value={value}>{children}</FrameContext.Provider>
}
