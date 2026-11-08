import { Settings } from 'lucide-react'
import { useState } from 'react'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { NeedsYouSection } from '../asks/NeedsYou'
import { useFrame } from './FrameContext'
import styles from './Panel.module.css'
import { ProjectsSection } from './ProjectsSection'
import { QuotaMeter } from './QuotaMeter'
import { SettingsMenu, SettingsPage } from './Settings'
import { SystemSection } from './SystemSection'

/** The left side's Panel, top to bottom: what waits on you (one section, asks and sessions together),
 * System (one line when all is well), then every project with its sessions. A footer pinned to the
 * bottom holds the Quota meter and Settings. On a phone Settings is a page inside the sheet, with Back. */
export function Panel({
  slots,
  currentId,
  onSelect,
}: {
  slots: Array<TerminalSlot | PaneSlot>
  currentId?: string
  onSelect: (slot: TerminalSlot | PaneSlot) => void
}) {
  const frame = useFrame()
  const sheet = frame !== null && !frame.docked
  const [settings, setSettings] = useState(false)
  if (sheet && settings)
    return (
      <div className={styles.panel} data-testid="session-sidebar">
        <SettingsPage frame={frame} onBack={() => setSettings(false)} />
      </div>
    )
  return (
    <div className={styles.panel} data-testid="session-sidebar">
      <div className={styles.scroll}>
        <NeedsYouSection
          slots={slots}
          currentId={currentId}
          onSelect={onSelect}
        />
        <div className={styles.glances}>
          <SystemSection />
        </div>
        <ProjectsSection
          slots={slots}
          currentId={currentId}
          onSelect={onSelect}
        />
      </div>
      <div className={styles.foot}>
        <QuotaMeter />
        {sheet ? (
          <button
            type="button"
            className={`lantern-btn ghost small ${styles.settingsWrap}`}
            onClick={() => setSettings(true)}
          >
            <Settings
              className="h-4 w-4"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            Settings
          </button>
        ) : (
          <SettingsMenu frame={frame} />
        )}
      </div>
    </div>
  )
}
