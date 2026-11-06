'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import styles from './ProjectsPage.module.css'

/** Under its badge on a desktop, a bottom sheet on the phone. Escape and a tap outside close it. */
export function Popover({
  label,
  onClose,
  children,
}: {
  label: string
  onClose: () => void
  children: ReactNode
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
      <div className={styles.scrim} aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        className={styles.pop}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
      >
        <h3>{label}</h3>
        {children}
      </div>
    </>
  )
}
