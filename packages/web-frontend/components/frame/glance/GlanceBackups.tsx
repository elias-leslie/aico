'use client'

import { spanText } from '@aico/shared/time'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import {
  ageByTarget,
  type BackupEntry,
  type BackupGroup,
  backupSummary,
  copyWord,
  groupBySource,
  refreshing,
  runnableTargets,
  type TargetAge,
  targetLabel,
} from '@/lib/backups'
import { useBackupRun } from '@/lib/hooks/use-backup-run'
import { useBackups } from '@/lib/hooks/use-backups'
import { useClock } from '@/lib/hooks/use-clock'
import { shortWhen } from '@/lib/short-when'
import styles from './Glance.module.css'
import own from './GlanceBackups.module.css'
import type { GlanceHead } from './glance-types'
import { OpenLink } from './OpenLink'

/** Past this many sources the list gets a find box. */
const FIND_FROM = 8

const late = (age: TargetAge) => age.ageMs > age.limitMs
const ageText = (age: TargetAge) =>
  `oldest ${spanText(age.ageMs)}, late after ${spanText(age.limitMs)}`

/** Backups for the heading: "All current", or how many sources are late or failed; why, when it is not known. */
export function useBackupsGlance(): GlanceHead {
  const { entries, loading } = useBackups()
  if (!entries)
    return loading
      ? { value: 'Checking…', tone: null }
      : { value: 'Couldn’t read', tone: 'failed' }
  if (entries.length === 0) return { value: 'None registered', tone: null }
  const groups = groupBySource(entries)
  const failed = groups.filter((group) => group.state === 'failed').length
  const lateOnes = groups.filter((group) => group.state === 'warn').length
  if (failed + lateOnes === 0) return { value: 'All current', tone: 'ok' }
  return {
    value: [
      failed ? `${failed} failed` : '',
      lateOnes ? `${lateOnes} late` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    tone: 'failed',
    needs: failed + lateOnes,
  }
}

const CHIP: Record<string, string> = {
  ok: 'ok',
  failed: 'failed',
  warn: 'late',
  off: 'off',
}
const chipOf = (entry: Pick<BackupEntry, 'state' | 'running'>) =>
  refreshing(entry) ? 'running' : (CHIP[entry.state] ?? 'late')

/** One copy of a source: where it is, how it stands, when it last had good data, and Restore. */
function Copy({ entry, machine }: { entry: BackupEntry; machine: boolean }) {
  return (
    <li className={own.copy}>
      <div className={own.copyHead}>
        <b>
          {targetLabel(entry.target)}
          {machine ? ` · ${entry.machine}` : ''}
        </b>
        <span className={`status-chip ${chipOf(entry)}`}>
          {copyWord(entry)}
        </span>
      </div>
      {entry.state !== 'ok' && entry.state !== 'off' && entry.meaning && (
        <p className={own.line}>{entry.meaning}</p>
      )}
      <p className={own.line}>
        Last good data: {shortWhen(entry.dataAt)}
        {entry.running ? (
          <> · Copying now</>
        ) : (
          entry.state !== 'off' &&
          entry.nextRun && <> · Next copy: {shortWhen(entry.nextRun)}</>
        )}
      </p>
      {entry.target !== 'external' && (
        <OpenLink
          href={`/backups/restore?source=${encodeURIComponent(entry.source)}&target=${entry.target}&name=${encodeURIComponent(entry.name)}`}
          label={`Restore ${entry.name} from ${targetLabel(entry.target)}`}
        >
          Restore files
        </OpenLink>
      )}
    </li>
  )
}

/** A source: its worst state in a chip; opens to its copies. Sources with a problem start open. */
function Source({ group, machine }: { group: BackupGroup; machine: boolean }) {
  const [open, setOpen] = useState(
    group.state === 'failed' || group.state === 'warn',
  )
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className={own.source} data-state={group.state}>
      <button
        type="button"
        className={own.sourceHead}
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
      >
        <Chevron className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden="true" />
        <span className={own.sourceName}>{group.name}</span>
        <span className={`status-chip ${CHIP[group.state] ?? 'late'}`}>
          {copyWord({ state: group.state, gone: group.retired })}
        </span>
      </button>
      {open && (
        <ul className={own.copies}>
          {group.copies.map((entry) => (
            <Copy key={entry.id} entry={entry} machine={machine} />
          ))}
        </ul>
      )}
    </li>
  )
}

function Fold({
  label,
  groups,
  machine,
  find,
}: {
  label: string
  groups: BackupGroup[]
  machine: boolean
  find: boolean
}) {
  const [open, setOpen] = useState(false)
  if (groups.length === 0) return null
  const Chevron = open || find ? ChevronDown : ChevronRight
  return (
    <div className={own.fold}>
      <button
        type="button"
        className={own.foldHead}
        aria-expanded={open || find}
        onClick={() => setOpen((now) => !now)}
      >
        <Chevron className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden="true" />
        {label} ({groups.length})
      </button>
      {(open || find) && (
        <ul className={own.sources}>
          {groups.map((group) => (
            <Source key={group.source} group={group} machine={machine} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** Per destination, how old its oldest copy is against its own limit; ember only when it is late. */
function Ages({ ages }: { ages: TargetAge[] }) {
  return (
    <ul className={styles.ages}>
      {ages.map((age) => (
        <li key={age.target} data-late={late(age) ? 'true' : undefined}>
          <span className={styles.agesName} title={`Oldest: ${age.name}`}>
            {targetLabel(age.target)}
          </span>
          <span
            className={styles.agesTrack}
            role="img"
            aria-label={`${targetLabel(age.target)}: ${ageText(age)}`}
          >
            <span
              style={{
                width: `${Math.min(100, Math.max(2, (age.ageMs / age.limitMs) * 100))}%`,
              }}
            />
          </span>
          <span className={styles.agesText}>{ageText(age)}</span>
        </li>
      ))}
    </ul>
  )
}

/** Backups: how old each destination is, Back up now, and every source with its copies and Restore. */
export function GlanceBackups() {
  const { entries, loading, stale } = useBackups()
  const now = useClock(60_000)
  const queryClient = useQueryClient()
  const { busy, message, failed, run } = useBackupRun(() =>
    queryClient.invalidateQueries({ queryKey: ['backups'] }),
  )
  const [search, setSearch] = useState('')
  if (!entries)
    return (
      <p className={styles.note} role={loading ? 'status' : 'alert'}>
        {loading ? 'Checking backups…' : 'Backups couldn’t be read.'}
      </p>
    )
  if (entries.length === 0)
    return <p className={styles.note}>No backups are registered yet.</p>
  const ages = ageByTarget(entries, now)
  const needle = search.trim().toLowerCase()
  const rows = needle
    ? entries.filter((row) =>
        `${row.name} ${targetLabel(row.target)} ${row.machine} ${row.meaning}`
          .toLowerCase()
          .includes(needle),
      )
    : entries
  const groups = groupBySource(rows)
  const live = groups.filter((group) => group.state !== 'off')
  const away = groups.filter((group) => group.state === 'off' && !group.retired)
  const archived = groups.filter(
    (group) => group.state === 'off' && group.retired,
  )
  const machine = new Set(entries.map((row) => row.machine)).size > 1
  const runnable = runnableTargets(entries)
  const finding = needle !== ''
  const sourceCount = new Set(entries.map((row) => row.source)).size
  return (
    <div className={own.wrap} data-stale={stale ? 'true' : undefined}>
      <p className={own.summary} role="status">
        {stale ? 'As of the last read: ' : ''}
        {backupSummary(entries)}
      </p>
      {ages.length > 0 && <Ages ages={ages} />}
      {runnable.length > 0 && (
        <div className={own.run} role="group" aria-label="Back up now">
          {runnable.map((target) => (
            <button
              key={target}
              type="button"
              className="lantern-btn small"
              disabled={!!busy}
              onClick={() => void run(target)}
            >
              {busy === target
                ? `Starting ${targetLabel(target)}…`
                : `Back up to ${targetLabel(target)} now`}
            </button>
          ))}
        </div>
      )}
      {message && (
        <p
          className={own.message}
          data-failed={failed ? 'true' : undefined}
          role={failed ? 'alert' : 'status'}
        >
          {message}
        </p>
      )}
      {sourceCount >= FIND_FROM || finding ? (
        <label className={`lantern-field ${own.find}`}>
          <input
            type="search"
            placeholder="Find a backup"
            aria-label="Find a backup"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      ) : null}
      {groups.length === 0 ? (
        <p className={styles.note}>No backups match.</p>
      ) : (
        <>
          <ul className={own.sources}>
            {live.map((group) => (
              <Source key={group.source} group={group} machine={machine} />
            ))}
          </ul>
          <Fold
            label="On a machine that is off"
            groups={away}
            machine={machine}
            find={finding}
          />
          <Fold
            label="Archived"
            groups={archived}
            machine={machine}
            find={finding}
          />
        </>
      )}
    </div>
  )
}
