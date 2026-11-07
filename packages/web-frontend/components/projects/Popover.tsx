'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import styles from './ProjectsPage.module.css'

/** Under its badge on a desktop, a bottom sheet on the phone. Escape and a tap outside close it. */
export function Popover({
  label,
  onClose,
  children,
  sheet,
}: {
  label: string
  onClose: () => void
  children: ReactNode
  /** A reading sheet (centred on a desktop, bottom sheet on the phone) with a Close button, not a small popover under a badge. */
  sheet?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [onClose])

  return (
    <>
      <div
        className={sheet ? `${styles.scrim} ${styles.scrimDim}` : styles.scrim}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={ref}
        className={sheet ? `${styles.pop} ${styles.sheet}` : styles.pop}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
      >
        {sheet ? (
          <div className={styles.sheetHead}>
            <h3>{label}</h3>
            <button
              type="button"
              className="lantern-btn small"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        ) : (
          <h3>{label}</h3>
        )}
        {children}
      </div>
    </>
  )
}
