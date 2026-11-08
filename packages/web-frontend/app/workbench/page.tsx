'use client'

import { ArrowLeft, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { TAB_VIEWS } from '@/components/workbench/tab-views'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import {
  inWorkbenchWindow,
  openWorkbench,
  readTab,
  splitOff,
  tabLabel,
  useHoldSplit,
  useSoloTab,
  useSplitTabs,
  WORKBENCH_TABS,
  WORKBENCH_TITLE,
  type WorkbenchTab,
  workbenchHref,
} from '@/lib/workbench'

const SPLIT_LABEL = 'Open in new window'

/** The Workbench: tabs of things to keep beside the sessions (Notes, Files), in a window of
 * their own. A tab can move to a window of its own, to snap one on each side of Aico; the
 * window it left says so and brings it forward. Each tab keeps its place in the address. */
function Workbench() {
  const router = useRouter()
  const params = useSearchParams()
  const solo = useSoloTab()
  const split = useSplitTabs()
  const desktop = useMediaQuery('(pointer: fine)')
  const [blocked, setBlocked] = useState(false)
  useHoldSplit(solo)
  useEffect(() => {
    document.title = WORKBENCH_TITLE
  }, [])

  const wanted = readTab(params.get('tab'))
  const tab: WorkbenchTab = solo ?? wanted ?? WORKBENCH_TABS[0].id
  const tabs = solo
    ? WORKBENCH_TABS.filter((entry) => entry.id === solo)
    : WORKBENCH_TABS
  const apart = !solo && split.includes(tab)
  const { Content } = TAB_VIEWS[tab]
  // In a window of the Workbench's own there is no session to go back to.
  const own = inWorkbenchWindow()

  const goTo = (next: WorkbenchTab) =>
    router.replace(workbenchHref(next, { project: params.get('project') }))
  const moveOut = (from: WorkbenchTab) => {
    if (
      !splitOff(
        from,
        from === tab ? params : { project: params.get('project') },
      )
    ) {
      setBlocked(true)
      return
    }
    setBlocked(false)
    if (from === tab) TAB_VIEWS[from].onSplit?.(params)
    // The tab left stays shown until its window has said it is there; then move to one that is here.
    const rest = WORKBENCH_TABS.find(
      (entry) => entry.id !== from && !split.includes(entry.id),
    )
    if (from === tab && rest) goTo(rest.id)
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ color: 'var(--bone)' }}
    >
      <h1 className="sr-only">{WORKBENCH_TITLE}</h1>
      <div className="flex flex-none items-center gap-1 px-2 pt-2 pb-1">
        {!own && (
          <Link
            href="/"
            className="lantern-icon-btn"
            aria-label="Back to sessions"
            title="Back to sessions"
          >
            <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
          </Link>
        )}
        <div
          role="tablist"
          aria-label="Workbench"
          className="flex min-w-0 flex-1 items-center gap-1"
        >
          {tabs.map((entry) => {
            const Icon = TAB_VIEWS[entry.id].icon
            const active = entry.id === tab
            const apartTab = !solo && split.includes(entry.id)
            return (
              <div key={entry.id} className="flex items-center">
                <button
                  type="button"
                  role="tab"
                  id={`workbench-tab-${entry.id}`}
                  aria-selected={active}
                  aria-controls="workbench-panel"
                  data-testid={`workbench-tab-${entry.id}`}
                  className="lantern-btn ghost"
                  style={{
                    height: 34,
                    padding: '0 10px',
                    color: active ? 'var(--lantern)' : undefined,
                    boxShadow: active
                      ? 'inset 0 -2px 0 var(--lantern)'
                      : undefined,
                    borderRadius: 0,
                  }}
                  onClick={() => goTo(entry.id)}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.7} />
                  {entry.label}
                </button>
                {desktop && !solo && !apartTab && (
                  <button
                    type="button"
                    className="lantern-icon-btn compact"
                    aria-label={`${SPLIT_LABEL}: ${entry.label}`}
                    title={`${SPLIT_LABEL}: ${entry.label}`}
                    data-testid={`workbench-split-${entry.id}`}
                    onClick={() => moveOut(entry.id)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.7} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {blocked && (
          <span
            role="alert"
            className="text-[12px]"
            style={{ color: 'var(--beacon)' }}
          >
            Pop-up blocked
          </span>
        )}
      </div>
      <div
        role="tabpanel"
        id="workbench-panel"
        aria-labelledby={`workbench-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {apart ? (
          <div className="files-state" data-testid="workbench-apart">
            <p>{tabLabel(tab)} is open in its own window.</p>
            <button
              type="button"
              className="lantern-btn mt-2"
              onClick={() => openWorkbench(tab, params)}
            >
              Show {tabLabel(tab)}
            </button>
          </div>
        ) : (
          <Content key={tab} />
        )}
      </div>
    </div>
  )
}

export default function WorkbenchPage() {
  return (
    <div
      className="h-dvh"
      style={{
        backgroundColor: 'var(--term-bg-deep)',
        height: 'var(--terminal-viewport-height, 100dvh)',
      }}
    >
      <Suspense fallback={null}>
        <Workbench />
      </Suspense>
    </div>
  )
}
