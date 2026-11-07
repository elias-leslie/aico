'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { type ReactNode, Suspense } from 'react'
import { SettingsDialog } from '../settings/SettingsDialog'
import { TerminalSkeleton } from '../TerminalSkeleton'
import { TerminalTabs } from '../TerminalTabs'
import styles from './Frame.module.css'
import { FrameProvider } from './FrameContext'
import { OfflineStrip } from './OfflineStrip'
import { settingsPlaceAt } from './settings-places'

/** Pages that stand alone: the popped-out notes window and the phone's
 * offline captures and mockups (they work from the saved copy). */
const STANDALONE = ['/notes', '/captures', '/mockups']

function isStandalone(pathname: string): boolean {
  return STANDALONE.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  )
}

/** The first non-empty value of a query parameter (`?project=&project=x` is x). */
function firstParam(params: URLSearchParams, name: string): string | undefined {
  return params.getAll(name).find((entry) => entry.length > 0)
}

/** The session side. A project link (`/?project=x&dir=...`) opens or starts
 * that project's session; elsewhere the query belongs to the page. */
function Sessions() {
  const params = useSearchParams()
  const home = (usePathname() ?? '/') === '/'
  return (
    <TerminalTabs
      projectId={home ? firstParam(params, 'project') : undefined}
      projectPath={home ? firstParam(params, 'dir') : undefined}
      className="flex-1 min-h-0"
    />
  )
}

/** One frame for every page (#18): the left side beside the session, with the
 * offline strip over both while the server can't be reached. Pages render
 * inside the left side; the session stays mounted while they change. */
export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/'
  if (isStandalone(pathname)) return children
  const settings = settingsPlaceAt(pathname)
  return (
    <FrameProvider page={children}>
      <div className={styles.frame} data-testid="app-frame">
        <OfflineStrip />
        <div className={styles.body}>
          {/* The page is a static file, so the query is read in the browser;
              the export renders the skeleton in its place. */}
          <Suspense fallback={<TerminalSkeleton />}>
            <Sessions />
          </Suspense>
        </div>
      </div>
      {/* Settings opens over the session, which stays mounted underneath. */}
      {settings && <SettingsDialog place={settings}>{children}</SettingsDialog>}
    </FrameProvider>
  )
}
