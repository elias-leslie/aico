'use client'

import { NotesPanel, NotesProvider } from '@summitflow/notes-ui'
import { DEFAULT_NOTES_PROJECT_SCOPE } from '@/lib/notes-config'

export default function NotesPage() {
  return (
    <NotesProvider apiPrefix="/api" projectScope={DEFAULT_NOTES_PROJECT_SCOPE}>
      <div
        className="flex h-dvh flex-col px-4 py-4 sm:px-6 sm:py-6"
        style={{ backgroundColor: 'var(--term-bg-deep)' }}
      >
        <div
          className="min-h-0 flex-1 overflow-hidden rounded-[2rem] border"
          style={{
            borderColor: 'var(--term-border)',
            backgroundColor: 'var(--term-bg-surface)',
            boxShadow: 'var(--term-shadow-modal)',
          }}
        >
          <NotesPanel />
        </div>
      </div>
    </NotesProvider>
  )
}
