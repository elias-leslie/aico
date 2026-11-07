'use client'

import { ArrowLeft, Settings as Gear } from 'lucide-react'
import Link from 'next/link'
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import type { Frame } from './FrameContext'
import styles from './Panel.module.css'
import { useBeside } from './RailPopover'
import { SETTINGS_PLACES } from './settings-places'

/** Opens a setup page over the side, the way every place opens from the Panel. */
function openPlace(
  event: MouseEvent<HTMLAnchorElement>,
  frame: Frame | null,
  href: string,
) {
  if (!frame) return
  event.preventDefault()
  frame.open(href, 'full')
}

/** The gear in the side's footer: a small menu listing the setup places (desktop and snapped windows).
 * In the Panel's footer it is a labelled button with the menu above it; on the Rail (`icon`) it is the
 * rail's own icon button with the menu beside the side. */
export function SettingsMenu({
  frame,
  icon = false,
}: {
  frame: Frame | null
  icon?: boolean
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const beside = useBeside(button, open && icon)
  const refs = useMemo(() => [button, menu], [])
  useClickOutside(refs, close, open)
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('a')?.focus()
  }, [open])
  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('a') ?? [])
  return (
    <div className={icon ? undefined : styles.settingsWrap}>
      <button
        ref={button}
        type="button"
        className={
          icon ? 'lantern-icon-btn compact' : 'lantern-btn ghost small'
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={icon ? 'Settings' : undefined}
        title={icon ? 'Settings' : undefined}
        onClick={() => setOpen((now) => !now)}
      >
        <Gear
          className={icon ? 'h-[18px] w-[18px]' : 'h-4 w-4'}
          strokeWidth={1.7}
          aria-hidden="true"
        />
        {!icon && 'Settings'}
      </button>
      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: the menu's own arrow and Escape keys
        <div
          ref={menu}
          role="menu"
          aria-label="Settings"
          className={`lantern-sheet lantern-enter ${icon ? styles.settingsMenuBeside : styles.settingsMenu}`}
          style={icon ? beside : undefined}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              close()
              button.current?.focus()
              return
            }
            const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
            if (!step) return
            event.preventDefault()
            const list = items()
            const at = list.indexOf(document.activeElement as HTMLElement)
            list[(at + step + list.length) % list.length]?.focus()
          }}
        >
          <div className={`lantern-sec ${styles.settingsHeading}`}>
            Settings
          </div>
          {SETTINGS_PLACES.map((place) => {
            const Icon = place.icon
            return (
              <Link
                key={place.href}
                href={place.href}
                role="menuitem"
                className="lantern-menu-item"
                onClick={(event) => {
                  close()
                  openPlace(event, frame, place.href)
                }}
              >
                <Icon
                  className="h-[18px] w-[18px]"
                  strokeWidth={1.7}
                  aria-hidden="true"
                />
                {place.label}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The phone's Settings page inside the sheet: each setup place as a row, and Back to the list. */
export function SettingsPage({
  frame,
  onBack,
}: {
  frame: Frame | null
  onBack: () => void
}) {
  return (
    <section
      className={styles.settingsPage}
      aria-label="Settings"
      data-settings-page=""
    >
      <div className={styles.settingsPageHead}>
        <button
          type="button"
          className="lantern-icon-btn"
          aria-label="Back"
          title="Back"
          onClick={onBack}
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={1.7} />
        </button>
        <h2>Settings</h2>
      </div>
      <nav aria-label="Settings places" className={styles.settingsRows}>
        {SETTINGS_PLACES.map((place) => {
          const Icon = place.icon
          return (
            <Link
              key={place.href}
              href={place.href}
              className={styles.settingsRow}
              onClick={(event) => {
                onBack()
                openPlace(event, frame, place.href)
              }}
            >
              <Icon className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
              <span>{place.label}</span>
              <span className={styles.settingsHint}>{place.hint}</span>
            </Link>
          )
        })}
      </nav>
    </section>
  )
}
