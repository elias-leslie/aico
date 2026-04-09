'use client'

import { NotesPanel, NotesProvider } from '@summitflow/notes-ui'
import { useEffect, useState } from 'react'
import {
  fetchNotesStatus,
  type NotesStatusResponse,
} from '@/lib/api/notes-status'

function formatStorageMode(mode: NotesStatusResponse['storage_mode']): string {
  return mode === 'companion' ? 'Shared library' : 'Standalone library'
}

function formatCatalogSource(
  source: NotesStatusResponse['project_catalog_source'],
): string {
  return source === 'companion' ? 'Project catalog: companion' : 'Project catalog: local'
}

function NotesWorkspacePage() {
  const [status, setStatus] = useState<NotesStatusResponse | null>(null)

  useEffect(() => {
    let active = true
    fetchNotesStatus()
      .then((nextStatus) => {
        if (active) setStatus(nextStatus)
      })
      .catch(() => {
        if (active) setStatus(null)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <NotesProvider apiPrefix="/api" projectScope="a-term">
      <div
        className="flex h-dvh flex-col px-4 py-4 sm:px-6 sm:py-6"
        style={{ backgroundColor: 'var(--term-bg-deep)' }}
      >
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <div
              className="mb-3 inline-flex rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.18em]"
              style={{ borderColor: 'var(--term-border-active)', color: 'var(--term-text-muted)' }}
            >
              A-Term Notes
            </div>
            <h1
              className="text-2xl font-semibold sm:text-3xl"
              style={{ color: 'var(--term-text-primary)', fontFamily: 'var(--font-ui)' }}
            >
              Notes stay available in standalone installs and can expand into a shared cross-project library.
            </h1>
            <p
              className="mt-2 max-w-2xl text-sm leading-6 sm:text-[15px]"
              style={{ color: 'var(--term-text-muted)' }}
            >
              Use this space for prompts, scratchpads, and working context without leaving the terminal grid.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <span
              className="rounded-full border px-3 py-1 text-xs"
              style={{ borderColor: 'var(--term-border)', color: 'var(--term-text-muted)' }}
            >
              Scope: a-term
            </span>
            {status ? (
              <>
                <span
                  className="rounded-full border px-3 py-1 text-xs"
                  style={{ borderColor: 'var(--term-border)', color: 'var(--term-text-muted)' }}
                >
                  {formatStorageMode(status.storage_mode)}
                </span>
                <span
                  className="rounded-full border px-3 py-1 text-xs"
                  style={{ borderColor: 'var(--term-border)', color: 'var(--term-text-muted)' }}
                >
                  {formatCatalogSource(status.project_catalog_source)}
                </span>
              </>
            ) : null}
          </div>
        </header>

        <div
          className="min-h-0 flex-1 overflow-hidden rounded-[2rem] border shadow-[0_24px_72px_rgba(0,0,0,0.34)]"
          style={{ borderColor: 'var(--term-border)', backgroundColor: 'rgba(8, 12, 18, 0.7)' }}
        >
          <NotesPanel />
        </div>
      </div>
    </NotesProvider>
  )
}

export default function NotesPage() {
  return <NotesWorkspacePage />
}
