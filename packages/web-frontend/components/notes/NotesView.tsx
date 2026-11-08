'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { type ReactNode, useEffect } from 'react'
import { CaptureLauncher } from '@/components/capture/CaptureLauncher'
import { OfflineBanner, ReadOnlyScope } from '@/components/ReadOnly'
import { isNoteId, newNoteKind, noteLinks, readScope } from '@/lib/api/notes'
import { setCapturePage } from '@/lib/capture-queue'
import { NoteEditor, noteScreenKey } from './NoteEditor'
import { NoteList } from './NoteList'
import { NoteLinksProvider, useNoteLinks } from './note-links'

function Notes({
  embedded,
  headerExtra,
}: {
  embedded: boolean
  headerExtra?: ReactNode
}) {
  const router = useRouter()
  const params = useSearchParams()
  const links = useNoteLinks()
  const id = params.get('id')
  const detail = isNoteId(id)
  // A New note: nothing saved until something is put in it.
  const fresh = id === null ? newNoteKind(params.get('new')) : null
  // The project this was opened for (a session's) and whether the list is widened to All.
  const scope = readScope(params)
  const listHref = links.list(scope)
  // A photo taken here belongs to that project too.
  useEffect(() => {
    setCapturePage(scope.project)
    return () => setCapturePage(null)
  }, [scope.project])
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
  const inNote = detail || fresh
  // The Workbench's tab already says Notes over the list.
  const title = detail
    ? 'Note'
    : fresh === 'list'
      ? 'New list'
      : fresh
        ? 'New note'
        : embedded
          ? null
          : 'Notes'
  return (
    <main
      className="mx-auto flex h-full w-full max-w-xl flex-col px-4"
      style={{ color: 'var(--bone)' }}
    >
      <OfflineBanner />
      <ReadOnlyScope>
        <header className="flex flex-none items-center gap-2 py-3">
          {(inNote || !embedded) && (
            <Link
              href={inNote ? listHref : '/'}
              className="lantern-icon-btn"
              aria-label={inNote ? 'Back to notes' : 'Back to sessions'}
              title={inNote ? 'Back to notes' : 'Back to sessions'}
            >
              <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Link>
          )}
          {title ? (
            <h1
              className="min-w-0 flex-1"
              style={{ font: '500 18px/1.2 var(--font-display)' }}
            >
              {title}
            </h1>
          ) : (
            <div className="min-w-0 flex-1" />
          )}
          {headerExtra}
          <CaptureLauncher variant="row" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
          {detail ? (
            <NoteEditor key={noteScreenKey(id)} id={id} listHref={listHref} />
          ) : fresh ? (
            <NoteEditor
              key={noteScreenKey(null)}
              id={null}
              kind={fresh}
              project={scope.project}
              listHref={listHref}
              onMade={(made) => router.replace(links.note(made, scope))}
            />
          ) : id !== null ? (
            <p className="py-3 text-[13px]" style={{ color: 'var(--mist)' }}>
              That isn&apos;t a note link.
            </p>
          ) : (
            <NoteList
              scope={scope}
              onScope={(all) =>
                router.replace(links.list({ project: scope.project, all }))
              }
            />
          )}
        </div>
      </ReadOnlyScope>
    </main>
  )
}

/** Notes: the list, or one note when the link carries its id. On its own page, or (`base` set)
 * as a tab of the Workbench, whose links then stay there. */
export function NotesView({
  base,
  headerExtra,
}: {
  base?: string
  headerExtra?: ReactNode
}) {
  const notes = (
    <Notes embedded={base !== undefined} headerExtra={headerExtra} />
  )
  return base ? (
    <NoteLinksProvider value={noteLinks(base)}>{notes}</NoteLinksProvider>
  ) : (
    notes
  )
}
