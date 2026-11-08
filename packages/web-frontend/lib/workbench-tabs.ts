// The Workbench's tabs and links: plain data, so a server page can read the title too.

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

export type Params = URLSearchParams | Record<string, string | null | undefined>

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
