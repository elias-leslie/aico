'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { ChevronLeft, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fetchPathInfo } from '@/lib/api/pane-files'
import type { FilesRequest } from '@/lib/files-opener'
import { FileBrowser, type FileChoice } from './FileBrowser'
import { SharedFiles } from './SharedFiles'

type View =
  | { kind: 'shared'; highlight?: string }
  | { kind: 'project' }
  | { kind: 'opening'; path: string }
  | { kind: 'missing'; path: string; message: string }
  | {
      kind: 'place'
      root: string
      select: FileChoice | null
      /** Opened from the Shared list, so Back returns there. */
      fromShared: boolean
    }

function initialView(
  request: FilesRequest | null,
  paneId: string | null,
): View {
  if (request?.kind === 'shared')
    return { kind: 'shared', highlight: request.showId }
  if (request?.kind === 'path') return { kind: 'opening', path: request.path }
  return paneId ? { kind: 'project' } : { kind: 'shared' }
}

/**
 * Files: what agents shared, the session's project folder, and any file or
 * folder by its path (clicked in the terminal). Everything is read where it
 * is; nothing is copied.
 */
export function FilesDialog({
  isOpen,
  paneId,
  request,
  onClose,
  onInsertPath,
  sessionName,
}: {
  isOpen: boolean
  /** The session's tab, whose folder the Project view shows */
  paneId: string | null
  /** What to show on opening; a new request reopens on it */
  request: FilesRequest | null
  onClose: () => void
  onInsertPath: (path: string) => void
  sessionName?: (session: string) => string | null
}) {
  const [view, setView] = useState<View>(() => initialView(request, paneId))
  const opening = useRef(0)

  async function openPath(path: string, fromShared: boolean) {
    const attempt = ++opening.current
    setView({ kind: 'opening', path })
    try {
      const info = await fetchPathInfo(path)
      if (attempt !== opening.current) return
      if (info.kind === 'folder') {
        setView({ kind: 'place', root: info.path, select: null, fromShared })
        return
      }
      const cut = info.path.lastIndexOf('/')
      const name = info.path.slice(cut + 1)
      setView({
        kind: 'place',
        root: info.path.slice(0, cut) || '/',
        select: { path: name, name },
        fromShared,
      })
    } catch (error) {
      if (attempt !== opening.current) return
      setView({
        kind: 'missing',
        path,
        message: (error as Error).message,
      })
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request reopens the view
  useEffect(() => {
    if (!isOpen) return
    const next = initialView(request, paneId)
    setView(next)
    if (next.kind === 'opening') void openPath(next.path, false)
  }, [request, isOpen])

  const tab =
    view.kind === 'project'
      ? 'project'
      : view.kind === 'shared' || (view.kind === 'place' && view.fromShared)
        ? 'shared'
        : null
  const insert = (path: string) => {
    onInsertPath(path)
    onClose()
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[70]"
          style={{ backgroundColor: 'var(--scrim)' }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className="lantern-sheet lantern-enter fixed inset-0 z-[71] flex flex-col overflow-hidden md:inset-x-6 md:top-6 md:bottom-6 md:rounded-[14px]"
        >
          <div className="flex flex-none items-center gap-2 pt-2 pr-2 pl-[18px]">
            <Dialog.Title
              className="m-0 flex-1"
              style={{ font: '500 18px/1.2 var(--font-display)' }}
            >
              Files
            </Dialog.Title>
            <button
              type="button"
              onClick={onClose}
              className="lantern-icon-btn"
              aria-label="Close files"
            >
              <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </button>
          </div>
          <div className="flex-none px-[18px] pt-1 pb-2.5">
            <fieldset aria-label="Show" className="lantern-seg">
              <button
                type="button"
                aria-pressed={tab === 'shared'}
                onClick={() => setView({ kind: 'shared' })}
              >
                Shared
              </button>
              {paneId && (
                <button
                  type="button"
                  aria-pressed={tab === 'project'}
                  onClick={() => setView({ kind: 'project' })}
                >
                  Project
                </button>
              )}
            </fieldset>
          </div>

          {view.kind === 'shared' ? (
            <SharedFiles
              highlight={view.highlight}
              sessionName={sessionName}
              onOpenPath={(path) => void openPath(path, true)}
            />
          ) : view.kind === 'project' && paneId ? (
            <FileBrowser
              key={`pane:${paneId}`}
              source={{ kind: 'pane', paneId }}
              onInsertPath={insert}
            />
          ) : view.kind === 'opening' ? (
            <p className="files-state">Opening {view.path}</p>
          ) : view.kind === 'missing' ? (
            <div className="files-state">
              <p>{view.message}</p>
              <p
                className="mt-1 break-all"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {view.path}
              </p>
            </div>
          ) : view.kind === 'place' ? (
            <>
              <div className="flex flex-none items-center gap-1 px-2 pb-2">
                {view.fromShared && (
                  <button
                    type="button"
                    className="lantern-icon-btn compact"
                    aria-label="Back to Shared"
                    onClick={() => setView({ kind: 'shared' })}
                  >
                    <ChevronLeft
                      className="h-[18px] w-[18px]"
                      strokeWidth={1.7}
                    />
                  </button>
                )}
                <p
                  className="m-0 min-w-0 flex-1 truncate px-2 text-xs"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--mist)',
                  }}
                  title={view.root}
                >
                  {view.root}
                </p>
              </div>
              <FileBrowser
                key={`at:${view.root}:${view.select?.path ?? ''}`}
                source={{ kind: 'location', root: view.root }}
                initialSelected={view.select}
                onInsertPath={insert}
              />
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
