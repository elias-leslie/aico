'use client'

import {
  FolderGit2,
  Info,
  Lock,
  Monitor,
  Radio,
  Server,
  Smartphone,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { shortWhen } from '@/lib/short-when'
import { Notice, Quiet, SectionHead, Switch } from './kit'
import styles from './NotificationsSection.module.css'

type Channel = 'phone' | 'desktop'

interface TypeRow {
  id: string
  label: string
  hint: string
  phone: { on: boolean; chosen: boolean }
  desktop: { on: boolean; chosen: boolean }
  fired: number
  phoned: number
}

interface FixedRow {
  id: string
  label: string
  hint: string
}

interface View {
  types: TypeRow[]
  fixed: FixedRow[]
}

interface RecentItem {
  id: string
  at: number
  title: string
  phone: string
  desktop: boolean
  why: string
  machine: string | null
  project: string | null
  raised_by: string | null
}

const PHONE_WORD: Record<string, string> = {
  sent: 'Reached the phone',
  queued: 'Waiting to reach the phone',
  failed: 'Did not reach the phone',
  unsure: 'May have reached the phone',
  silenced: 'Kept off the phone',
  none: 'Not sent to the phone',
}

const SILENCE_MEANS =
  'Off stops the phone push or the desktop card. The notice still lands in the tray, Needs you and the digest.'

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function Recent({ type }: { type: string }) {
  const [items, setItems] = useState<RecentItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    fetch(`/api/notifications/recent?type=${encodeURIComponent(type)}`, {
      cache: 'no-store',
    })
      .then((response) => {
        if (!response.ok) throw new Error('unreadable')
        return response.json()
      })
      .then((result) => {
        if (!live) return
        setItems(result.items)
        setTotal(result.total ?? result.items.length)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [type])
  if (failed)
    return (
      <Quiet role="alert">
        The recent ones could not be read. Close this and try again.
      </Quiet>
    )
  if (!items) return <Quiet role="status">Reading the recent ones…</Quiet>
  if (items.length === 0) return <Quiet>None in the last 7 days.</Quiet>
  return (
    <ul className={styles.recent}>
      {total > items.length && (
        <li className={styles.recentMore}>
          <span title="The newest ones from the last 7 days">
            {items.length} of {total}
          </span>
        </li>
      )}
      {items.map((item) => (
        <li key={item.id}>
          <div className={styles.recentHead}>
            <span className={styles.recentTitle}>{item.title}</span>
            <time className={styles.recentWhen}>{shortWhen(item.at)}</time>
          </div>
          <div className={styles.recentRoute}>
            <span
              className={styles.routeIcon}
              data-on={item.phone === 'sent' ? 'true' : undefined}
              title={PHONE_WORD[item.phone] ?? item.phone}
            >
              <Smartphone
                className="h-3.5 w-3.5"
                strokeWidth={1.7}
                aria-label={PHONE_WORD[item.phone] ?? item.phone}
              />
            </span>
            <span
              className={styles.routeIcon}
              data-on={item.desktop ? 'true' : undefined}
              title={item.desktop ? 'Desktop card' : 'No desktop card'}
            >
              <Monitor
                className="h-3.5 w-3.5"
                strokeWidth={1.7}
                aria-label={item.desktop ? 'Desktop card' : 'No desktop card'}
              />
            </span>
            <span className={styles.why}>{item.why}</span>
          </div>
          <div className={styles.recentAbout}>
            {item.machine && (
              <span className={styles.chip} title={`About ${item.machine}`}>
                <Server
                  className="h-3 w-3"
                  strokeWidth={1.7}
                  aria-label="Machine"
                />
                {item.machine}
              </span>
            )}
            {item.project && (
              <span
                className={styles.chip}
                title={`About the project ${item.project}`}
              >
                <FolderGit2
                  className="h-3 w-3"
                  strokeWidth={1.7}
                  aria-label="Project"
                />
                {item.project}
              </span>
            )}
            {item.raised_by && (
              <span
                className={styles.chip}
                data-from="true"
                title={`Raised by the Aico on ${item.raised_by}`}
              >
                <Radio
                  className="h-3 w-3"
                  strokeWidth={1.7}
                  aria-label="Raised by the Aico on"
                />
                {item.raised_by}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Notifications: one row per type, with a phone and a desktop switch, and what fired this week. */
export function NotificationsSection() {
  const [data, setData] = useState<View | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [saveError, setSaveError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [explain, setExplain] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/notifications', { cache: 'no-store' })
      if (!response.ok) throw new Error('unreadable')
      setData(await response.json())
      setError('')
    } catch {
      setError('Notifications could not be read.')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const saves = useRef(0)

  async function save(row: TypeRow, channel: Channel, on: boolean) {
    const mine = ++saves.current
    setSaving(`${row.id}/${channel}`)
    setSaveError('')
    try {
      const response = await fetch('/api/notifications/choice', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: row.id, channel, on }),
      })
      if (!response.ok) throw new Error('refused')
      const fresh = await response.json()
      // Each answer holds the whole list: an older answer arriving late must not undo a newer switch.
      if (mine === saves.current) setData(fresh)
    } catch {
      setSaveError(
        `${row.label} on the ${channel} was not saved. It is still ${row[channel].on ? 'on' : 'off'}.`,
      )
    } finally {
      if (mine === saves.current) setSaving(null)
    }
  }

  return (
    <section aria-label="Notifications">
      <SectionHead title="Notifications">
        <button
          type="button"
          className="lantern-icon-btn compact"
          aria-label="What off means"
          aria-expanded={explain}
          title={SILENCE_MEANS}
          onClick={() => setExplain((now) => !now)}
        >
          <Info className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
        </button>
      </SectionHead>
      {explain && <Quiet>{SILENCE_MEANS}</Quiet>}
      {error && (
        <Notice
          failed
          actions={
            <button
              type="button"
              className="lantern-btn small"
              onClick={() => void load()}
            >
              Try again
            </button>
          }
        >
          {error}
          {data ? ' Showing the last read.' : ''}
        </Notice>
      )}
      {saveError && <Notice failed>{saveError}</Notice>}
      {!data && !error && <Quiet role="status">Reading notifications…</Quiet>}
      {data && (
        <div className={styles.table}>
          <div className={styles.columns} aria-hidden="true">
            <span
              className={styles.countHead}
              title="How many in the last 7 days. Tap a count to see them."
            >
              <small>7 days</small>
            </span>
            <span title="Phone push">
              <Smartphone className="h-4 w-4" strokeWidth={1.7} />
              <small>Phone</small>
            </span>
            <span title="Desktop card">
              <Monitor className="h-4 w-4" strokeWidth={1.7} />
              <small>Desktop</small>
            </span>
          </div>
          <ul className={styles.rows}>
            {data.types.map((row) => (
              <li key={row.id} className={styles.row} data-testid={row.id}>
                <div className={styles.line}>
                  <div className={styles.name}>
                    <span title={row.hint}>{row.label}</span>
                    <button
                      type="button"
                      className={styles.count}
                      data-none={row.fired === 0 ? 'true' : undefined}
                      aria-expanded={open === row.id}
                      aria-label={`${plural(row.fired, 'notice')} in the last 7 days, ${row.phoned} to the phone. Show the recent ones.`}
                      title={`${plural(row.fired, 'notice')} in the last 7 days, ${row.phoned} to the phone`}
                      onClick={() =>
                        setOpen((now) => (now === row.id ? null : row.id))
                      }
                    >
                      {row.fired}
                    </button>
                  </div>
                  {(['phone', 'desktop'] as const).map((channel) => (
                    <Switch
                      key={channel}
                      label={`${row.label} on the ${channel}`}
                      title={`${row.label}: ${channel} ${row[channel].on ? 'on' : 'off'}`}
                      checked={row[channel].on}
                      busy={saving === `${row.id}/${channel}`}
                      onChange={(on) => void save(row, channel, on)}
                    />
                  ))}
                </div>
                {open === row.id && (
                  <div className={styles.detail}>
                    <small>{row.hint}</small>
                    <Recent type={row.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <ul className={styles.rows} aria-label="Built into the phone app">
            {data.fixed.map((row) => (
              <li key={row.id} className={styles.row} data-testid={row.id}>
                <div className={styles.line}>
                  <div className={styles.name}>
                    <span title={row.hint}>{row.label}</span>
                    <button
                      type="button"
                      className={styles.count}
                      data-none="true"
                      aria-expanded={open === row.id}
                      aria-label={`${row.label}: not counted, and no switch here. Show why.`}
                      title="Not counted: the phone keeps this itself"
                      onClick={() =>
                        setOpen((now) => (now === row.id ? null : row.id))
                      }
                    >
                      ?
                    </button>
                  </div>
                  <span
                    className={styles.locked}
                    title={row.hint}
                    aria-label={`${row.label} on the phone: on, no switch`}
                    role="img"
                  >
                    <Lock
                      className="h-3.5 w-3.5"
                      strokeWidth={1.7}
                      aria-hidden="true"
                    />
                  </span>
                  <span className={styles.locked} aria-hidden="true">
                    –
                  </span>
                </div>
                {open === row.id && (
                  <div className={styles.detail}>
                    <small>{row.hint}</small>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
