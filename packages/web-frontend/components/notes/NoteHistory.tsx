'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { formatWhen } from '@/lib/capture-format'
import { useNoteRevisions } from '@/lib/hooks/use-notes'

/** Earlier versions of the title and text, newest first, each with Restore. */
export function NoteHistory({
  noteId,
  onOpenChange,
  onRestore,
}: {
  noteId: string
  onOpenChange: (open: boolean) => void
  onRestore: (field: 'title' | 'body', text: string) => void
}) {
  const history = useNoteRevisions(noteId)
  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000]"
          style={{ backgroundColor: 'var(--scrim)' }}
        />
        <Dialog.Content
          data-testid="note-history"
          aria-describedby={undefined}
          className="lantern-sheet lantern-rise fixed inset-x-0 bottom-0 z-[10001] flex max-h-[85dvh] flex-col overflow-hidden rounded-t-[14px] outline-none md:inset-x-auto md:top-1/2 md:left-1/2 md:bottom-auto md:max-h-[min(80dvh,640px)] md:w-[min(94vw,520px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl"
          style={{ color: 'var(--bone)' }}
        >
          <div className="flex items-center gap-3 py-3 pr-2 pl-[18px]">
            <Dialog.Title
              className="min-w-0 flex-1"
              style={{ font: '500 18px/1.2 var(--font-display)' }}
            >
              History
            </Dialog.Title>
            <Dialog.Close aria-label="Close" className="lantern-icon-btn">
              <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[18px] pb-[18px]">
            {history.isLoading ? (
              <p
                role="status"
                className="text-[13px]"
                style={{ color: 'var(--mist)' }}
              >
                Loading history…
              </p>
            ) : history.isError ? (
              <p
                role="status"
                className="text-[13px]"
                style={{ color: 'var(--mist)' }}
              >
                Couldn&apos;t load the history.{' '}
                <button
                  type="button"
                  className="min-h-11 underline underline-offset-2"
                  style={{ color: 'var(--lantern)' }}
                  onClick={() => void history.refetch()}
                >
                  Try again
                </button>
              </p>
            ) : (history.data ?? []).length === 0 ? (
              <p className="text-[13px]" style={{ color: 'var(--mist)' }}>
                No earlier versions yet. Aico keeps one every few minutes while
                you change the title or the text.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {(history.data ?? []).map((revision) => (
                  <li
                    key={revision.id}
                    data-testid="note-revision"
                    className="flex flex-col gap-1 rounded-lg p-3"
                    style={{ background: 'var(--paper)' }}
                  >
                    <span
                      className="text-[12px]"
                      style={{ color: 'var(--mist)' }}
                    >
                      {revision.field === 'title' ? 'Title' : 'Text'} ·{' '}
                      {formatWhen(revision.savedAt)}
                    </span>
                    <span className="line-clamp-4 whitespace-pre-wrap break-words text-[13px]">
                      {revision.text}
                    </span>
                    <button
                      type="button"
                      className="lantern-btn min-h-11 self-start"
                      onClick={() => {
                        onRestore(revision.field, revision.text)
                        onOpenChange(false)
                      }}
                    >
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
