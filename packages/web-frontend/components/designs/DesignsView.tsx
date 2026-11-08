'use client'

import {
  Code2,
  ExternalLink,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Shapes,
} from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { type ComponentType, useEffect, useMemo, useState } from 'react'
import { OfflineBanner, ReadOnlyScope } from '@/components/ReadOnly'
import { RenderedView } from '@/components/render/RenderedView'
import {
  chooseDesign,
  type Design,
  designFrameUrl,
  saveDesignNote,
} from '@/lib/api/designs'
import { formatAge } from '@/lib/attention'
import { useDesigns } from '@/lib/hooks/use-designs'
import { useNoteProjects } from '@/lib/hooks/use-note-projects'
import { KIND_LABEL, type RenderKind } from '@/lib/render'
import { shortWhen } from '@/lib/short-when'
import { workbenchHref } from '@/lib/workbench-tabs'
import styles from './Designs.module.css'

const ICONS: Record<
  RenderKind,
  ComponentType<{ className?: string; strokeWidth?: number }>
> = {
  html: Code2,
  svg: Shapes,
  image: ImageIcon,
  pdf: FileText,
  markdown: FileText,
  mermaid: GitBranch,
}

const STATE_LABEL: Record<Design['state'], string> = {
  pending: 'Pending',
  selected: 'Selected',
  passed: 'Not selected',
}

interface Group {
  project: string
  designs: Design[]
  latest: string
}

/** Designs by project: the project the window was opened for first, then the most recently
 * touched; newest design first inside each. */
function groupByProject(designs: Design[], first: string | null): Group[] {
  const groups = new Map<string, Group>()
  for (const design of designs) {
    const group = groups.get(design.project) ?? {
      project: design.project,
      designs: [],
      latest: design.updatedAt,
    }
    group.designs.push(design)
    if (design.updatedAt > group.latest) group.latest = design.updatedAt
    groups.set(design.project, group)
  }
  for (const group of groups.values())
    group.designs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return [...groups.values()].sort((a, b) =>
    a.project === first
      ? -1
      : b.project === first
        ? 1
        : b.latest.localeCompare(a.latest),
  )
}

/** The note box and the choice for one design, as on the old Mockups page. */
function Review({
  design,
  changed,
}: {
  design: Design
  changed: (design: Design) => void
}) {
  const [note, setNote] = useState(design.note)
  const [working, setWorking] = useState<'save' | 'select' | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    setNote(design.note)
  }, [design.note])
  const pending = design.state === 'pending'
  const act = async (action: 'save' | 'select') => {
    setWorking(action)
    setError('')
    setMessage('')
    try {
      changed(
        await (action === 'select' ? chooseDesign : saveDesignNote)(
          design,
          note,
        ),
      )
      setMessage(action === 'select' ? 'Choice saved.' : 'Note saved.')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The change could not be saved',
      )
    } finally {
      setWorking(null)
    }
  }
  return (
    <div className={styles.review}>
      <label htmlFor={`design-note-${design.id}`}>Note</label>
      <textarea
        id={`design-note-${design.id}`}
        value={note}
        maxLength={1000}
        rows={2}
        disabled={!pending || working !== null}
        onChange={(event) => {
          setNote(event.target.value)
          setMessage('')
        }}
        aria-label={`Note for ${design.title}`}
      />
      <div className={styles.actions}>
        {pending && (
          <>
            <button
              type="button"
              className="lantern-btn small"
              disabled={working !== null || note === design.note}
              onClick={() => void act('save')}
            >
              {working === 'save' ? 'Saving…' : 'Save note'}
            </button>
            <button
              type="button"
              className="lantern-btn small primary"
              disabled={working !== null}
              onClick={() => void act('select')}
            >
              {working === 'select' ? 'Sending…' : 'Use this one'}
            </button>
          </>
        )}
        {message && <p role="status">{message}</p>}
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * The Workbench's Designs tab: what agents added with `st mockup add`, by project, and the one
 * chosen rendered beside it (in place of the list's lower half on a phone). The list is polled,
 * and a design added again under the same title reloads where it is open. The address keeps the
 * project to show first (`project`) and the design open (`design`).
 */
export function DesignsView() {
  const router = useRouter()
  const params = useSearchParams()
  const project = params.get('project')
  const picked = params.get('design')
  const state = useDesigns()
  const { nameOf } = useNoteProjects()
  const { designs } = state
  const groups = useMemo(
    () => groupByProject(designs, project),
    [designs, project],
  )
  const found = designs.find((design) => design.id === picked)
  const selected = found ?? groups[0]?.designs[0] ?? null
  const gone = !!picked && state.loaded && !found

  const open = (design: Design) =>
    router.replace(workbenchHref('designs', { project, design: design.id }))

  const stateLine = state.isLoading ? (
    <p className="files-state">Loading designs</p>
  ) : state.isError ? (
    <div className="files-state">
      <p>Couldn’t load designs{state.error ? `: ${state.error}` : ''}.</p>
      <button
        type="button"
        className="lantern-btn small mt-3"
        onClick={state.refetch}
      >
        Try again
      </button>
    </div>
  ) : null

  return (
    <>
      <OfflineBanner />
      <ReadOnlyScope>
        {state.isStale && (
          <p
            role="status"
            data-testid="designs-stale"
            className="files-note"
            style={{ color: 'var(--beacon)' }}
          >
            Couldn’t refresh. This is the list from{' '}
            {formatAge(Date.now() - state.updatedAt)} ago.{' '}
            <button
              type="button"
              className="lantern-btn small"
              onClick={state.refetch}
            >
              Try again
            </button>
          </p>
        )}
        {state.unreadable > 0 && (
          <p role="status" className="files-note">
            {state.unreadable === 1
              ? 'One project’s designs'
              : `${state.unreadable} projects’ designs`}{' '}
            couldn’t be read. This list is partial.
          </p>
        )}
        {gone && (
          <p role="status" className="files-note">
            That design was removed.
          </p>
        )}
        {stateLine ??
          (designs.length === 0 ? (
            <p className="files-state" data-testid="designs-empty">
              No designs yet. Designs an agent adds show up here as it makes
              them.
            </p>
          ) : (
            <div className={styles.layout}>
              <div className={styles.list} data-open={!!selected}>
                {project && !groups.some((g) => g.project === project) && (
                  <p className="files-note" style={{ padding: '4px 10px 8px' }}>
                    {nameOf(project)} has no designs yet.
                  </p>
                )}
                {groups.map((group) => (
                  <section
                    key={group.project}
                    className={styles.group}
                    aria-label={nameOf(group.project)}
                  >
                    <h2 className="lantern-sec">
                      {nameOf(group.project)}
                      <span className="n">{group.designs.length}</span>
                    </h2>
                    <ul>
                      {group.designs.map((design) => {
                        const Icon = ICONS[design.kind]
                        return (
                          <li key={design.id}>
                            <button
                              type="button"
                              className="lantern-file-row"
                              aria-current={selected?.id === design.id}
                              title={`${KIND_LABEL[design.kind]}, updated ${shortWhen(design.updatedAt)}`}
                              onClick={() => open(design)}
                            >
                              <Icon
                                className="h-[18px] w-[18px]"
                                strokeWidth={1.7}
                              />
                              <span className="n">{design.title}</span>
                              <span
                                className="lantern-chip"
                                data-tone={
                                  design.state === 'pending'
                                    ? 'wait'
                                    : undefined
                                }
                              >
                                {STATE_LABEL[design.state]}
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                ))}
              </div>
              {selected && (
                <section className={styles.viewer} aria-label={selected.title}>
                  <div className={styles.head}>
                    <h2 title={selected.title}>{selected.title}</h2>
                    <a
                      href={selected.viewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="lantern-btn small"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {selected.kind === 'pdf' || selected.kind === 'image'
                        ? 'Open file'
                        : 'Open page'}
                    </a>
                    <p className={styles.meta}>
                      {nameOf(selected.project)} · {KIND_LABEL[selected.kind]} ·
                      updated {shortWhen(selected.updatedAt)}
                    </p>
                  </div>
                  <RenderedView
                    key={selected.id}
                    kind={selected.kind}
                    src={designFrameUrl(selected)}
                    title={`Design: ${selected.title}`}
                    className={styles.frame}
                  />
                  <Review
                    key={selected.id}
                    design={selected}
                    changed={state.replace}
                  />
                </section>
              )}
            </div>
          ))}
      </ReadOnlyScope>
    </>
  )
}
