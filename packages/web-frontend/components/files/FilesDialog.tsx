'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { ChevronLeft, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  fetchPathInfo,
  type ProjectSource,
  sourceKey,
} from '@/lib/api/pane-files'
import type { FilesRequest } from '@/lib/files-opener'
import { useFilePlaces, useProjectRoot } from '@/lib/hooks/use-pane-files'
import { FileBrowser, type FileChoice } from './FileBrowser'
import {
  defaultSort,
  readShowHidden,
  type SortBy,
  saveShowHidden,
} from './listing'
import { Breadcrumb, ListControls, PlaceBar } from './PlaceBar'
import { SharedFiles } from './SharedFiles'

type View =
  | { kind: 'shared'; highlight?: string }
  | { kind: 'project' }
  /** Everywhere, waiting for Home to be known */
  | { kind: 'start' }
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
  project: ProjectSource | null,
): View {
  if (request?.kind === 'shared')
    return { kind: 'shared', highlight: request.showId }
  if (request?.kind === 'path') return { kind: 'opening', path: request.path }
  return project ? { kind: 'project' } : { kind: 'start' }
}

/**
 * Files: the session's project folder, and everywhere else on this computer
 * (a path box, a breadcrumb up to `/`, Home, scratch folders, and what agents
 * shared). A session opens on its project; with none it opens on Home.
 * Everything is read where it is; nothing is copied.
 */
export function FilesDialog({
  isOpen,
  project,
  request,
  onClose,
  onInsertPath,
  sessionName,
}: {
  isOpen: boolean
  /** The session's folder (its tab's, or its own), which the Project view shows */
  project: ProjectSource | null
  /** What to show on opening; a new request reopens on it */
  request: FilesRequest | null
  onClose: () => void
  onInsertPath: (path: string) => void
  sessionName?: (session: string) => string | null
}) {
  const [view, setView] = useState<View>(() => initialView(request, project))
  const opening = useRef(0)
  // The owner's pick of order holds across folders; until then each folder has its own default.
  const [sortPick, setSortPick] = useState<SortBy | null>(null)
  const [showHidden, setShowHiddenState] = useState(readShowHidden)
  const setShowHidden = (show: boolean) => {
    setShowHiddenState(show)
    saveShowHidden(show)
  }
  const places = useFilePlaces()
  const projectRoot = useProjectRoot(project)
  const home = places.data?.places?.[0]?.path ?? null
  const remoteHost = projectRoot.data?.host ?? null

  const goFolder = (root: string, fromShared = false) => {
    opening.current += 1
    setView({ kind: 'place', root, select: null, fromShared })
  }
  // Everywhere opens where the project is, else on Home.
  const goEverywhere = () => {
    const root = projectRoot.data?.root ?? (projectRoot.isLoading ? null : home)
    if (root) goFolder(root)
    else setView({ kind: 'start' })
  }

  const startAt = projectRoot.data?.root ?? home
  useEffect(() => {
    if (view.kind === 'start' && !projectRoot.isLoading && startAt)
      setView({ kind: 'place', root: startAt, select: null, fromShared: false })
  }, [view.kind, projectRoot.isLoading, startAt])

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
    const next = initialView(request, project)
    setView(next)
    if (next.kind === 'opening') void openPath(next.path, false)
  }, [request, isOpen])

  const sort =
    sortPick ??
    (view.kind === 'place'
      ? defaultSort(
          view.root,
          places.data?.places,
          projectRoot.data?.root ?? null,
        )
      : 'name')
  const tab = view.kind === 'project' ? 'project' : 'everywhere'
  const here = view.kind === 'place' ? view.root : null
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
          className="lantern-sheet lantern-enter fixed inset-0 z-[71] flex flex-col overflow-hidden max-md:bottom-auto max-md:h-[var(--terminal-viewport-height,100dvh)] md:inset-x-6 md:top-6 md:bottom-6 md:rounded-[14px]"
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
          {project && (
            <div className="flex-none px-[18px] pt-1 pb-2.5">
              <fieldset aria-label="Show" className="lantern-seg compact">
                <button
                  type="button"
                  aria-pressed={tab === 'project'}
                  onClick={() => setView({ kind: 'project' })}
                >
                  This project
                </button>
                <button
                  type="button"
                  aria-pressed={tab === 'everywhere'}
                  onClick={goEverywhere}
                >
                  Everywhere
                </button>
              </fieldset>
            </div>
          )}

          {view.kind === 'project' ? (
            <>
              {projectRoot.data?.root ? (
                <div className="files-pathrow">
                  <Breadcrumb
                    path={projectRoot.data.root}
                    onGo={(path) => goFolder(path)}
                  />
                </div>
              ) : remoteHost ? (
                <p className="files-note">On {remoteHost}</p>
              ) : null}
              {project && (
                <FileBrowser
                  key={sourceKey(project)}
                  source={project}
                  onInsertPath={insert}
                />
              )}
            </>
          ) : (
            <>
              <PlaceBar
                path={here}
                places={places.data?.places}
                placesFailed={places.isError}
                sharedActive={view.kind === 'shared'}
                onGo={(path) => void openPath(path, false)}
                onFolder={(path) => goFolder(path)}
                onShared={() => setView({ kind: 'shared' })}
              />
              {remoteHost && (
                <p className="files-note">
                  These are this computer’s files. {remoteHost}’s files are
                  under This project.
                </p>
              )}
              {view.kind === 'shared' ? (
                <SharedFiles
                  highlight={view.highlight}
                  sessionName={sessionName}
                  onOpenPath={(path) => void openPath(path, true)}
                />
              ) : view.kind === 'start' ? (
                <p className="files-state">
                  {places.isError
                    ? 'Couldn’t find Home. Type a path above.'
                    : 'Opening Home'}
                </p>
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
                  <div className="files-pathrow">
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
                    <Breadcrumb
                      path={view.root}
                      onGo={(path) => goFolder(path)}
                    />
                  </div>
                  <ListControls
                    sort={sort}
                    onSort={setSortPick}
                    showHidden={showHidden}
                    onShowHidden={setShowHidden}
                  />
                  <FileBrowser
                    key={`at:${view.root}:${view.select?.path ?? ''}`}
                    source={{ kind: 'location', root: view.root }}
                    initialSelected={view.select}
                    onInsertPath={insert}
                    shared={view.fromShared}
                    view={{ sort, showHidden }}
                  />
                </>
              ) : null}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
