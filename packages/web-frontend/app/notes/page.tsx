'use client'

import { ArrowLeft, SquareArrowOutUpRight } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { CaptureLauncher } from '@/components/capture/CaptureLauncher'
import {
  handOffNote,
  NoteEditor,
  noteScreenKey,
} from '@/components/notes/NoteEditor'
import { NoteList } from '@/components/notes/NoteList'
import { OfflineBanner, ReadOnlyScope } from '@/components/ReadOnly'
import { isNoteId, newNoteKind, noteHref } from '@/lib/api/notes'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { popOutNotes, useIsNotesWindow } from '@/lib/notes-window'

const POP_OUT = 'Pop out into its own window'

/** Moves notes into their own window, to snap beside other work; this window
 * goes back to the sessions. Desktop only: a phone has no side window. */
function PopOut({ id }: { id: string | null }) {
  const router = useRouter()
  const desktop = useMediaQuery('(pointer: fine)')
  const [blocked, setBlocked] = useState(false)
  if (!desktop) return null
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
        aria-label={POP_OUT}
        title={blocked ? 'Allow pop-ups for Aico, then try again' : POP_OUT}
        data-testid="notes-pop-out"
        onClick={() => {
          if (!popOutNotes(id ? noteHref(id) : undefined)) {
            setBlocked(true)
            return
          }
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

/** The Notes page: the list, or one note when the link carries its id. */
function Notes() {
  const router = useRouter()
  const params = useSearchParams()
  const id = params.get('id')
  const detail = isNoteId(id)
  // A New note: nothing saved until something is put in it.
  const fresh = id === null ? newNoteKind(params.get('new')) : null
  // The popped-out window is only notes: no way back to the sessions here.
  const popped = useIsNotesWindow()
  // Closing the window or switching away ends the edit in hand: an item or
  // label being typed saves when its box loses focus.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return
      const box = document.activeElement
      if (box instanceof HTMLInputElement) box.blur()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])
  return (
    <main
      className="mx-auto flex h-full w-full max-w-xl flex-col px-4"
      style={{ color: 'var(--bone)' }}
    >
      <OfflineBanner />
      <ReadOnlyScope>
        <header className="flex flex-none items-center gap-2 py-3">
          {(detail || fresh || !popped) && (
            <Link
              href={detail || fresh ? '/notes' : '/'}
              className="lantern-icon-btn"
              aria-label={
                detail || fresh ? 'Back to notes' : 'Back to sessions'
              }
              title={detail || fresh ? 'Back to notes' : 'Back to sessions'}
            >
              <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Link>
          )}
          <h1
            className="min-w-0 flex-1"
            style={{ font: '500 18px/1.2 var(--font-display)' }}
          >
            {detail
              ? 'Note'
              : fresh === 'list'
                ? 'New list'
                : fresh
                  ? 'New note'
                  : 'Notes'}
          </h1>
          {!popped && <PopOut id={detail ? id : null} />}
          <CaptureLauncher variant="row" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
          {detail ? (
            <NoteEditor key={noteScreenKey(id)} id={id} />
          ) : fresh ? (
            <NoteEditor
              key={noteScreenKey(null)}
              id={null}
              kind={fresh}
              onMade={(made) => router.replace(noteHref(made))}
            />
          ) : id !== null ? (
            <p className="py-3 text-[13px]" style={{ color: 'var(--mist)' }}>
              That isn&apos;t a note link.
            </p>
          ) : (
            <NoteList />
          )}
        </div>
      </ReadOnlyScope>
    </main>
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
        <Notes />
      </Suspense>
    </div>
  )
}
