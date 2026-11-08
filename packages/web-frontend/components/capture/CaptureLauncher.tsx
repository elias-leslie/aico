'use client'

import { Camera } from 'lucide-react'
import { useState } from 'react'
import { captureQueueLeft, useCaptureQueue } from '@/lib/capture-queue'
import { CaptureSheet } from './CaptureSheet'

/** `bar` and `touch` are the session bar's: a ghost button with its word when there is room, and a 44px icon on a phone. */
type Variant = 'icon' | 'row' | 'bar' | 'touch'

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
      {variant === 'icon' || variant === 'touch' ? (
        <button
          type="button"
          className={`lantern-icon-btn relative${variant === 'icon' ? ' compact' : ''}`}
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
      ) : variant === 'bar' ? (
        <button
          type="button"
          className="lantern-btn ghost"
          style={{ height: 34, padding: '0 10px' }}
          onClick={() => setOpen(true)}
          aria-label={label}
          title={label}
          data-testid="capture-btn"
        >
          <Camera className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          <span className="hidden @min-[760px]:inline">Capture</span>
          {waiting > 0 && (
            <span aria-hidden="true" style={{ color: 'var(--lantern)' }}>
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
