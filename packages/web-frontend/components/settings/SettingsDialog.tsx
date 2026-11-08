'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type ReactNode, useState } from 'react'
import { homeHref } from '@/lib/frame/shown-session'
import { SETTINGS_PLACES, type SettingsPlace } from '../frame/settings-places'
import styles from './SettingsDialog.module.css'

/** Settings: one large dialog over the session (a full-screen sheet on a phone). Its own short list
 * switches section; the section's page (the route's content) fills the right side. Esc, the close
 * button or a click outside go back to the session, and focus returns to where it was. */
export function SettingsDialog({
  place,
  children,
}: {
  place: SettingsPlace
  children: ReactNode
}) {
  const router = useRouter()
  // Where focus was when the dialog opened (the gear or a menu item).
  const [opener] = useState<Element | null>(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  )
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) router.push(homeHref())
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.scrim} />
        <Dialog.Content
          className={`lantern-sheet lantern-enter ${styles.dialog}`}
          data-testid="settings-dialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            const back =
              opener instanceof HTMLElement && opener.isConnected
                ? opener
                : document.querySelector<HTMLElement>('[data-settings-gear]')
            if (!back) return
            event.preventDefault()
            back.focus()
          }}
        >
          <header className={styles.head}>
            <Dialog.Title className={styles.title}>Settings</Dialog.Title>
            <Dialog.Close
              className="lantern-icon-btn compact"
              aria-label="Close settings"
              title="Close · Esc"
            >
              <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Dialog.Close>
          </header>
          <nav className={styles.nav} aria-label="Settings sections">
            {SETTINGS_PLACES.map((entry) => {
              const Icon = entry.icon
              return (
                <Link
                  key={entry.href}
                  href={entry.href}
                  replace
                  scroll={false}
                  className={styles.item}
                  aria-current={entry.href === place.href ? 'page' : undefined}
                  title={entry.hint}
                  aria-label={entry.label}
                >
                  <Icon
                    className="h-4 w-4"
                    strokeWidth={1.7}
                    aria-hidden="true"
                  />
                  <span className={styles.label}>{entry.label}</span>
                </Link>
              )
            })}
          </nav>
          <div className={styles.pane} data-testid="settings-pane">
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
