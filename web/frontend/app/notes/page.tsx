'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { CaptureLauncher } from '@/components/capture/CaptureLauncher'
import { NoteEditor } from '@/components/notes/NoteEditor'
import { NoteList } from '@/components/notes/NoteList'
import { OfflineBanner, ReadOnlyScope } from '@/components/ReadOnly'
import { isNoteId } from '@/lib/api/notes'

/** The Notes page: the list, or one note when the link carries its id. */
function Notes() {
  const id = useSearchParams().get('id')
  const detail = isNoteId(id)
  return (
    <main
      className="mx-auto flex h-full w-full max-w-xl flex-col px-4"
      style={{ color: 'var(--bone)' }}
    >
      <OfflineBanner />
      <ReadOnlyScope>
        <header className="flex flex-none items-center gap-2 py-3">
          <Link
            href={detail ? '/notes' : '/'}
            className="lantern-icon-btn"
            aria-label={detail ? 'Back to notes' : 'Back to sessions'}
            title={detail ? 'Back to notes' : 'Back to sessions'}
          >
            <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
          </Link>
          <h1
            className="min-w-0 flex-1"
            style={{ font: '500 18px/1.2 var(--font-display)' }}
          >
            {detail ? 'Note' : 'Notes'}
          </h1>
          <CaptureLauncher variant="row" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
          {detail ? (
            <NoteEditor key={id} id={id} />
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
