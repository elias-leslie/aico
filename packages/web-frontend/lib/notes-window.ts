'use client'

import { useSyncExternalStore } from 'react'
import { newNoteHref, notesHref } from './api/notes'
import { shownProject } from './frame/shown-project'

/** The name of the popped-out notes window. A window keeps its name across
 * page loads, so the notes page can tell it is in that window. */
export const NOTES_WINDOW = 'aico-notes'

/** A narrow, tall window, ready to snap beside other work. */
const FEATURES = 'popup,width=440,height=860'

/** Opens `href` in the notes window (or brings it to that page when it is
 * already open). By default a New note with the cursor in it: the window is
 * for quick notes. Returns false when the browser blocked it. */
export function popOutNotes(href: string = newNoteHref('note')): boolean {
  const opened = window.open(href, NOTES_WINDOW, FEATURES)
  if (!opened) return false
  opened.focus()
  return true
}

/** True inside the popped-out notes window; false on the server and in the
 * main window. */
export function useIsNotesWindow(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => window.name === NOTES_WINDOW,
    () => false,
  )
}

/** The Notes entry (the button in the panel, the rail and the side list, and later the session
 * bar): Notes in its own window, on `project`'s notes, defaulting to the project of the session on
 * screen. null opens All. Where the browser blocks the window, Notes opens in this one. */
export function openNotes(project: string | null = shownProject()): void {
  const href = notesHref({ project })
  if (!popOutNotes(href)) window.location.assign(href)
}
