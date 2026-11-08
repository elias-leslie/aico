'use client'

import { Folder, Palette, StickyNote } from 'lucide-react'
import type { ComponentType } from 'react'
import { DesignsView } from '@/components/designs/DesignsView'
import { handOffNote } from '@/components/notes/NoteEditor'
import { NotesView } from '@/components/notes/NotesView'
import type { WorkbenchTab } from '@/lib/workbench'
import { FilesTab } from './FilesTab'

interface TabView {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  Content: ComponentType
  /** Runs as the tab moves to a window of its own, with the address it had. */
  onSplit?: (params: URLSearchParams) => void
}

/** What each tab of the Workbench shows. A tab missing here is a type error. */
export const TAB_VIEWS: Record<WorkbenchTab, TabView> = {
  notes: {
    icon: StickyNote,
    Content: () => <NotesView base="/workbench?tab=notes" />,
    // The note open here is open there now: leaving it here must not delete it as blank.
    onSplit: (params) => {
      const id = params.get('id')
      if (id) handOffNote(id)
    },
  },
  files: { icon: Folder, Content: FilesTab },
  designs: { icon: Palette, Content: DesignsView },
}
