'use client'

import { Camera } from 'lucide-react'
import { useState } from 'react'
import { captureQueueLeft, useCaptureQueue } from '@/lib/capture-queue'
import { CaptureSheet } from './CaptureSheet'

type Variant = 'icon' | 'row'

const TITLE = 'Capture: take a photo or send files'

/** The Capture entry, mounted beside Needs you in the session list, rail,
 * switcher and header; never inside a session's view. A count shows files
 * still waiting to be sent. */
export function CaptureLauncher({ variant = 'icon' }: { variant?: Variant }) {
  const [open, setOpen] = useState(false)
  const { items } = useCaptureQueue()
  const waiting = captureQueueLeft(items)
  const label = waiting > 0 ? `${TITLE} (${waiting} waiting)` : TITLE
  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          className="lantern-icon-btn compact relative"
          onClick={() => setOpen(true)}
          aria-label={label}
          title={label}
          data-testid="capture-btn"
        >
          <Camera className="h-[18px] w-[18px]" strokeWidth={1.7} />
          {waiting > 0 && (
            <span aria-hidden="true" className="lantern-rail-count">
              {waiting}
            </span>
          )}
        </button>
      ) : (
        <button
          type="button"
          className="lantern-btn ghost small"
          onClick={() => setOpen(true)}
          aria-label={label}
          title={label}
          data-testid="capture-btn"
        >
          <Camera className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          Capture
          {waiting > 0 && (
            <span aria-hidden="true" style={{ color: 'var(--lantern)' }}>
              {waiting}
            </span>
          )}
        </button>
      )}
      {open && <CaptureSheet open onOpenChange={setOpen} />}
    </>
  )
}
