'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ProjectSource } from '@/lib/api/pane-files'
import type { FilesRequest } from '@/lib/files-opener'
import { FilesPanel } from './FilesPanel'

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
  /** Absent with no session open: there is no terminal to put a path into, so the button is not offered. */
  onInsertPath?: (path: string) => void
  sessionName?: (session: string) => string | null
}) {
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
          <FilesPanel
            isOpen={isOpen}
            project={project}
            request={request}
            onInsertPath={onInsertPath}
            onClose={onClose}
            sessionName={sessionName}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
