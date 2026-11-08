'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { notesHref } from './api/notes'
import { shownProject } from './frame/shown-project'

/** The tabs of the Workbench, in order. A new tab is a row here and a view in
 * components/workbench/tab-views.tsx (the type keeps the two in step). */
export const WORKBENCH_TABS = [
  { id: 'notes', label: 'Notes' },
  { id: 'files', label: 'Files' },
] as const

export type WorkbenchTab = (typeof WORKBENCH_TABS)[number]['id']

export const WORKBENCH_TITLE = 'Aico Workbench'

/** What the Workbench holds, for the tooltip of every button that opens it. */
export const workbenchTip = () =>
  `Workbench: ${WORKBENCH_TABS.map((tab) => tab.label).join(', ')}`

export const tabLabel = (tab: WorkbenchTab) =>
  WORKBENCH_TABS.find((entry) => entry.id === tab)?.label ?? tab

export function readTab(value: string | null): WorkbenchTab | null {
  return WORKBENCH_TABS.find((tab) => tab.id === value)?.id ?? null
}

type Params = URLSearchParams | Record<string, string | null | undefined>

/** A tab's link: the tab, and whatever state it keeps in the address (its project, folder, note). */
export function workbenchHref(tab: WorkbenchTab, params: Params = {}): string {
  const query = new URLSearchParams({ tab })
  const pairs =
    params instanceof URLSearchParams
      ? params.entries()
      : Object.entries(params)
  for (const [key, value] of pairs)
    if (value && key !== 'tab') query.set(key, value)
  return `/workbench?${query}`
}

/** The window the Workbench opens in, with every tab. A window keeps its name across page loads. */
const WORKBENCH_WINDOW = 'aico-workbench'

/** The window of a tab split off on its own. */
const splitWindow = (tab: WorkbenchTab) => `${WORKBENCH_WINDOW}-${tab}`

/** True in a window the Workbench opened (the shared one, or a tab's own): no session to go back to. */
export const inWorkbenchWindow = () =>
  window.name === WORKBENCH_WINDOW ||
  window.name.startsWith(`${WORKBENCH_WINDOW}-`)

/** Tall and narrow, ready to snap beside other work. */
const FEATURES = 'popup,width=520,height=860'

/** A window beside the session is for a mouse and a wide screen; a phone keeps things in place. */
function hasSideWindows(): boolean {
  return window.matchMedia?.('(pointer: fine)').matches ?? true
}

function open(href: string, name: string): boolean {
  const opened = window.open(href, name, FEATURES)
  if (!opened) return false
  opened.focus()
  return true
}

// -- Which tabs have a window of their own ---------------------------------------------------
// A split-off window stamps the time every couple of seconds; one that closed (or crashed)
// stops, and its tab is the main window's again.

const stampKey = (tab: WorkbenchTab) => `aico-workbench-split:${tab}`
const STAMP_EVERY_MS = 2000
const STAMP_FRESH_MS = 5000

function stamp(tab: WorkbenchTab, on: boolean) {
  try {
    if (on) localStorage.setItem(stampKey(tab), String(Date.now()))
    else localStorage.removeItem(stampKey(tab))
  } catch {}
}

function isSplit(tab: WorkbenchTab): boolean {
  try {
    const at = Number(localStorage.getItem(stampKey(tab)))
    return at > 0 && Date.now() - at < STAMP_FRESH_MS
  } catch {
    return false
  }
}

/** The tab this window holds alone, or null in the window with every tab. */
export function useSoloTab(): WorkbenchTab | null {
  const name = useSyncExternalStore(
    () => () => {},
    () => window.name,
    () => '',
  )
  return WORKBENCH_TABS.find((tab) => name === splitWindow(tab.id))?.id ?? null
}

/** While this window holds `tab` alone, tells the others it does. */
export function useHoldSplit(tab: WorkbenchTab | null): void {
  useEffect(() => {
    if (!tab) return
    stamp(tab, true)
    const timer = setInterval(() => stamp(tab, true), STAMP_EVERY_MS)
    const leave = () => stamp(tab, false)
    window.addEventListener('pagehide', leave)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [tab])
}

/** The tabs that have a window of their own right now. */
export function useSplitTabs(): WorkbenchTab[] {
  const [split, setSplit] = useState<WorkbenchTab[]>([])
  useEffect(() => {
    const read = () => {
      const now = WORKBENCH_TABS.filter((tab) => isSplit(tab.id)).map(
        (tab) => tab.id,
      )
      setSplit((before) =>
        before.length === now.length && before.every((tab, i) => tab === now[i])
          ? before
          : now,
      )
    }
    read()
    const timer = setInterval(read, STAMP_EVERY_MS)
    return () => clearInterval(timer)
  }, [])
  return split
}

// -- Opening ---------------------------------------------------------------------------------

/** Opens the Workbench on `tab` and brings it forward: the tab's own window when it has one,
 * else the Workbench window. False where the browser blocked it or there is no side window to
 * open (a phone), so the caller keeps things in place. */
export function openWorkbench(tab: WorkbenchTab, params?: Params): boolean {
  if (!hasSideWindows()) return false
  return open(
    workbenchHref(tab, params),
    isSplit(tab) ? splitWindow(tab) : WORKBENCH_WINDOW,
  )
}

/** `tab` in a window of its own ("Open in new window"). False where the browser blocked it. */
export function splitOff(tab: WorkbenchTab, params?: Params): boolean {
  return open(workbenchHref(tab, params), splitWindow(tab))
}

/** The Notes entry (the button in the panel, the rail, the side list and the session bar): the
 * Workbench on Notes, on `project`'s notes, defaulting to the project of the session on screen.
 * null opens All. Where there is no side window (a phone) or the browser blocks it, Notes
 * opens in this one. */
export function openNotes(project: string | null = shownProject()): void {
  if (openWorkbench('notes', { project })) return
  window.location.assign(notesHref({ project }))
}

/** The Files entry: the Workbench on Files, on the folder of `project`, or on Home with none.
 * `path` opens that file's folder; `shared` opens what agents shared. False where Files should
 * stay in place (a phone, a session on another host, a blocked window). */
export function openFilesWindow(
  options: {
    project?: string | null
    /** A session outside any project: its folder */
    session?: string | null
    path?: string
    shared?: string | true
  } = {},
): boolean {
  const { project, session, path, shared } = options
  return openWorkbench('files', {
    project,
    session: project ? null : session,
    path,
    view: shared ? 'shared' : undefined,
    show: typeof shared === 'string' ? shared : undefined,
  })
}
