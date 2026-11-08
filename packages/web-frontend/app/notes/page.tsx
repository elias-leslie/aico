'use client'

import { SquareArrowOutUpRight } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { handOffNote } from '@/components/notes/NoteEditor'
import { NotesView } from '@/components/notes/NotesView'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { openWorkbench, workbenchTip } from '@/lib/workbench'

/** Moves the open notes into the Workbench window, to snap beside other work; this window goes
 * back to the sessions. Desktop only: a phone has no side window. */
function PopOut() {
  const router = useRouter()
  const params = useSearchParams()
  const desktop = useMediaQuery('(pointer: fine)')
  const [blocked, setBlocked] = useState(false)
  if (!desktop) return null
  const label = 'Open in the Workbench window'
  return (
    <>
      {blocked && (
        <span
          role="alert"
          className="text-[12px]"
          style={{ color: 'var(--beacon)' }}
        >
          Pop-up blocked
        </span>
      )}
      <button
        type="button"
        className="lantern-icon-btn"
        aria-label={label}
        title={
          blocked
            ? 'Allow pop-ups for Aico, then try again'
            : `${label}. ${workbenchTip()}`
        }
        data-testid="notes-pop-out"
        onClick={() => {
          if (!openWorkbench('notes', params)) {
            setBlocked(true)
            return
          }
          const id = params.get('id')
          if (id) handOffNote(id)
          router.push('/')
        }}
      >
        <SquareArrowOutUpRight
          className="h-[18px] w-[18px]"
          strokeWidth={1.7}
        />
      </button>
    </>
  )
}

export default function NotesPage() {
  return (
    <div
      className="h-dvh"
      style={{
        backgroundColor: 'var(--term-bg-deep)',
        height: 'var(--terminal-viewport-height, 100dvh)',
      }}
    >
      <Suspense fallback={null}>
        <NotesView headerExtra={<PopOut />} />
      </Suspense>
    </div>
  )
}
