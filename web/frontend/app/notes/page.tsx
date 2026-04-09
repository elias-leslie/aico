'use client'

import { NotesPanel, NotesProvider } from '@summitflow/notes-ui'
import { useEffect, useState } from 'react'
import {
  fetchNotesStatus,
  type NotesStatusResponse,
} from '@/lib/api/notes-status'

function formatStorageMode(mode: NotesStatusResponse['storage_mode']): string {
  return mode === 'companion'
    ? 'SummitFlow shared notes storage'
    : 'A-Term local notes storage'
}

function formatCatalogSource(
  source: NotesStatusResponse['project_catalog_source'],
): string {
  return source === 'companion'
    ? 'Project scopes from SummitFlow companion'
    : 'Project scopes from A-Term local catalog'
}

function getModeHeadline(status: NotesStatusResponse | null): string {
  if (!status) {
    return 'Use notes, prompts, and scratchpads without leaving the terminal grid.'
  }

  if (status.storage_mode === 'companion') {
    return "Notes and prompts are currently backed by SummitFlow's shared library, so this workspace can span projects instead of staying A-Term-only."
  }

  return 'Notes and prompts are currently stored inside A-Term itself, so this workspace stays local and A-Term-centric until a SummitFlow companion is configured.'
}

function getModeDetail(status: NotesStatusResponse | null): string {
  if (!status) {
    return 'A-Term always keeps a standalone notes path available. When the companion is configured, the same page switches to SummitFlow-backed shared storage and catalog data.'
  }

  if (status.storage_mode === 'companion') {
    return 'SummitFlow now owns the shared notes and prompt library. Scope options come from the companion project catalog, which means you can browse prompts and notes across projects from one place.'
  }

  return "A-Term owns the notes and prompt storage in this mode. Scope options come from A-Term's own project registry, and companion-only refinement or formatting actions stay unavailable until shared mode is configured."
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
              style={{
                borderColor: 'var(--term-border-active)',
                color: 'var(--term-text-muted)',
              }}
            >
              A-Term Notes
            </div>
            <h1
              className="text-2xl font-semibold sm:text-3xl"
              style={{
                color: 'var(--term-text-primary)',
                fontFamily: 'var(--font-ui)',
              }}
            >
              Notes stay local in standalone installs and switch to SummitFlow's
              shared library when the companion is configured.
            </h1>
            <p
              className="mt-2 max-w-2xl text-sm leading-6 sm:text-[15px]"
              style={{ color: 'var(--term-text-muted)' }}
            >
              {getModeHeadline(status)}
            </p>
            <p
              className="mt-2 max-w-2xl text-sm leading-6 sm:text-[15px]"
              style={{ color: 'var(--term-text-muted)' }}
            >
              {getModeDetail(status)}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <span
              className="rounded-full border px-3 py-1 text-xs"
              style={{
                borderColor: 'var(--term-border)',
                color: 'var(--term-text-muted)',
              }}
            >
              Scope: a-term
            </span>
            {status ? (
              <>
                <span
                  className="rounded-full border px-3 py-1 text-xs"
                  style={{
                    borderColor: 'var(--term-border)',
                    color: 'var(--term-text-muted)',
                  }}
                >
                  {formatStorageMode(status.storage_mode)}
                </span>
                <span
                  className="rounded-full border px-3 py-1 text-xs"
                  style={{
                    borderColor: 'var(--term-border)',
                    color: 'var(--term-text-muted)',
                  }}
                >
                  {formatCatalogSource(status.project_catalog_source)}
                </span>
                <span
                  className="rounded-full border px-3 py-1 text-xs"
                  style={{
                    borderColor: 'var(--term-border)',
                    color: 'var(--term-text-muted)',
                  }}
                >
                  {status.storage_mode === 'companion'
                    ? 'Shared prompts can span projects'
                    : 'Prompt refinement stays off in standalone mode'}
                </span>
              </>
            ) : null}
          </div>
        </header>

        <div
          className="min-h-0 flex-1 overflow-hidden rounded-[2rem] border shadow-[0_24px_72px_rgba(0,0,0,0.34)]"
          style={{
            borderColor: 'var(--term-border)',
            backgroundColor: 'rgba(8, 12, 18, 0.7)',
          }}
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
