'use client'

import {
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import { useFrame } from './FrameContext'
import styles from './RailPopover.module.css'

const GAP = 8
const MARGIN = 12
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const CloseContext = createContext<(() => void) | null>(null)

/** Closes the pop-out a piece of content sits in; null when it is not in one. */
export function usePopoverClose(): (() => void) | null {
  return useContext(CloseContext)
}

/** Where a pop-out sits: just right of the side, level with its icon, growing
 * downward from an icon in the upper half and upward from one in the lower half. */
export function useBeside(
  button: RefObject<HTMLElement | null>,
  open: boolean,
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>()
  useLayoutEffect(() => {
    if (!open) return
    const rect = button.current?.getBoundingClientRect()
    if (!rect) return
    const side = button.current
      ?.closest('[data-frame-side]')
      ?.getBoundingClientRect()
    const left = (side?.right ?? rect.right) + GAP
    const height = window.innerHeight
    setStyle(
      rect.top + rect.height / 2 > height / 2
        ? {
            left,
            bottom: height - rect.bottom - 4,
            maxHeight: rect.bottom + 4 - MARGIN,
          }
        : {
            left,
            top: rect.top - 4,
            maxHeight: height - rect.top + 4 - MARGIN,
          },
    )
  }, [open, button])
  return style
}

function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) => element.offsetParent !== null || element === root,
  )
}

/** A rail icon that opens a non-modal pop-out beside the side, over the session
 * (the side keeps its width, so the session does not refit). Click or Enter and
 * Space open it and move focus in; Esc or a click outside closes it and puts
 * focus back on the icon; Tab stays inside. */
export function RailPopover({
  label,
  panelLabel,
  className,
  icon,
  hint = 'Esc closes',
  extra,
  children,
}: {
  /** The icon's tooltip and accessible name. */
  label: string
  /** The pop-out's accessible name. */
  panelLabel: string
  className: string
  /** What the icon button holds: the glyph and any badge. */
  icon: ReactNode
  /** The line pinned under the content. */
  hint?: string
  /** More attributes for the icon button (test ids, aria-current). */
  extra?: Record<string, string | number | undefined>
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const frame = useFrame()
  const close = useCallback(() => setOpen(false), [])
  const refs = useMemo(() => [button, dialog], [])
  const place = useBeside(button, open)
  const giveBack = useCallback(() => {
    setOpen(false)
    button.current?.focus()
  }, [])
  useClickOutside(refs, giveBack, open)
  // A page opened from inside (or any route change) leaves the pop-out behind.
  const pathname = frame?.pathname
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on the route changing
  useEffect(() => setOpen(false), [pathname])
  useEffect(() => {
    if (!open) return
    const root = dialog.current
    if (root && !root.contains(document.activeElement))
      (root.querySelector<HTMLElement>('[data-autofocus]') ?? root).focus()
    const away = () => setOpen(false)
    // The icon moving (the rail's own list scrolling) strands the pop-out; the session scrolling does not.
    const moved = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(button.current))
        setOpen(false)
    }
    window.addEventListener('resize', away)
    window.addEventListener('scroll', moved, true)
    return () => {
      window.removeEventListener('resize', away)
      window.removeEventListener('scroll', moved, true)
    }
  }, [open])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      giveBack()
      return
    }
    if (event.key !== 'Tab' || !dialog.current) return
    const list = tabbables(dialog.current)
    const first = list[0]
    const last = list[list.length - 1]
    const active = document.activeElement
    if (!first || !last) event.preventDefault()
    else if (
      event.shiftKey &&
      (active === first || active === dialog.current)
    ) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
        {...extra}
      >
        {icon}
      </button>
      {open && (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the pop-out's own Escape and Tab keys
        <div
          ref={dialog}
          role="dialog"
          aria-label={panelLabel}
          tabIndex={-1}
          className={`lantern-sheet lantern-enter ${styles.popover}`}
          style={place}
          onKeyDown={onKeyDown}
        >
          <div className={styles.body}>
            <CloseContext.Provider value={close}>
              {children}
            </CloseContext.Provider>
          </div>
          <p className={styles.hint}>{hint}</p>
        </div>
      )}
    </>
  )
}
