'use client'

import {
  type ReadonlyURLSearchParams,
  useRouter,
  useSearchParams,
} from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilesPanel } from '@/components/files/FilesPanel'
import type { FilePlace, ProjectSource } from '@/lib/api/pane-files'
import type { FilesRequest } from '@/lib/files-opener'
import { useProjectSettings } from '@/lib/hooks/use-project-settings'
import { workbenchHref } from '@/lib/workbench'

/**
 * The Files tab: the project's folder to start in, and everywhere else on this
 * computer. The address keeps the folder (`path`), or `view=shared`, so the
 * window can be reloaded or bookmarked. The address that opened it decides where
 * it starts; moving about only updates the address.
 */
const startAt = (params: ReadonlyURLSearchParams) => ({
  path: params.get('path'),
  shared: params.get('view') === 'shared',
  show: params.get('show') ?? undefined,
})

/** Where an address points, to tell an address this tab wrote from Back or Forward. */
const placeOf = (shared: boolean, path: string | null) =>
  `${shared ? 'shared' : ''}|${path ?? ''}`

export function FilesTab() {
  const router = useRouter()
  const params = useSearchParams()
  const project = params.get('project')
  const session = params.get('session')
  const [start, setStart] = useState(() => startAt(params))
  const address = placeOf(params.get('view') === 'shared', params.get('path'))
  // Back and Forward move the view; an address this tab wrote itself doesn't.
  const wrote = useRef(address)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new address moves the view
  useEffect(() => {
    if (address === wrote.current) return
    wrote.current = address
    setStart(startAt(params))
  }, [address])
  const { projects, isLoading } = useProjectSettings()
  const found = projects.find((entry) => entry.id === project)
  const root = found?.root_path ?? null
  // Without a project, the folder of a session, when the link names one.
  const source: ProjectSource | null =
    !project && session ? { kind: 'session', sessionId: session } : null
  const waiting = !!project && !start.path && !start.shared && isLoading

  const request = useMemo<FilesRequest | null>(() => {
    if (start.shared) return { kind: 'shared', showId: start.show }
    if (start.path) return { kind: 'path', path: start.path }
    return root ? { kind: 'path', path: root } : null
  }, [start, root])

  const places = useMemo<FilePlace[] | undefined>(
    () =>
      root && project
        ? [{ id: 'project', label: found?.name ?? project, path: root }]
        : undefined,
    [root, project, found?.name],
  )

  const onLocate = useCallback(
    (folder: string | null) => {
      wrote.current = placeOf(!folder, folder)
      const href = workbenchHref('files', {
        project,
        session: project ? null : session,
        path: folder,
        view: folder ? null : 'shared',
      })
      // Leaving Shared for a file's folder is a step Back can undo.
      if (folder && address.startsWith('shared|')) router.push(href)
      else router.replace(href)
    },
    [router, project, session, address],
  )

  if (waiting) return <p className="files-state">Finding {project}’s folder</p>
  if (project && !isLoading && !root && !start.path && !start.shared)
    return (
      <>
        <p className="files-note">
          {project} has no folder here. Showing Home.
        </p>
        <FilesPanel project={null} request={null} onLocate={onLocate} />
      </>
    )
  return (
    <FilesPanel
      project={source}
      request={request}
      extraPlaces={places}
      onLocate={onLocate}
    />
  )
}
