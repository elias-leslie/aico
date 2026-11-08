'use client'

import { spanText } from '@aico/shared/time'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import {
  ageByTarget,
  type BackupEntry,
  type BackupTarget,
  backupSummary,
  copyWord,
  groupBySource,
  runnableTargets,
  targetLabel,
} from '@/lib/backups'
import { backupsApi } from '@/lib/backups-api'
import { useServerReach } from '@/lib/frame/server-reach'
import { useBackupRun } from '@/lib/hooks/use-backup-run'
import { machineLabel } from '@/lib/machine-name'
import { shortWhen } from '@/lib/short-when'
import styles from './BackupsPage.module.css'

type Entry = BackupEntry

type Target = BackupTarget
interface Overview {
  machine: string
  entries: Entry[]
  runs: Record<string, { started: string; finished?: string; ok: boolean }>
}
interface Snapshot {
  id: string
  time: string
  paths: string[]
}
interface FileNode {
  name: string
  path: string
  type: string
  size?: number
}
const title = targetLabel
const when = shortWhen
const api = backupsApi
function Header({ restore = false }: { restore?: boolean }) {
  return (
    <header>
      {restore && (
        <Link className="lantern-btn ghost small" href="/backups">
          Backups
        </Link>
      )}
      <h1>{restore ? 'Restore files' : 'Backups'}</h1>
      <Link className="lantern-btn ghost small" href="/status?kind=backup">
        Status
      </Link>
    </header>
  )
}
const badgeWord = copyWord

function Copy({ row, machine }: { row: Entry; machine: boolean }) {
  return (
    <li>
      <div>
        <strong>
          {title(row.target)}
          {machine ? ` · ${machineLabel(row.machine)}` : ''}
        </strong>
        {row.state !== 'ok' && row.state !== 'off' && <p>{row.meaning}</p>}
        <small>
          Last good data: {when(row.dataAt)}
          {row.state !== 'off' && row.nextRun && (
            <>
              <br />
              Next copy: {when(row.nextRun)}
            </>
          )}
        </small>
      </div>
      <span className={styles.badge} data-state={row.state}>
        {badgeWord(row)}
      </span>
      <div className={styles.actions}>
        {row.target === 'external' ? (
          <Link
            className="lantern-btn ghost small"
            href={row.path || '/status'}
          >
            Open status
          </Link>
        ) : (
          <Link
            className="lantern-btn ghost small"
            href={`/backups/restore?source=${encodeURIComponent(row.source)}&target=${row.target}&name=${encodeURIComponent(row.name)}`}
          >
            Restore
          </Link>
        )}
      </div>
    </li>
  )
}

function Group({
  group,
  machine,
}: {
  group: ReturnType<typeof groupBySource>[number]
  machine: boolean
}) {
  return (
    <li className={styles.group} data-state={group.state}>
      <h3>{group.name}</h3>
      <ul className={styles.copies}>
        {group.copies.map((row) => (
          <Copy key={row.id} row={row} machine={machine} />
        ))}
      </ul>
    </li>
  )
}

/** Per destination, the oldest live copy against its own limit. */
function AgeChart({ entries }: { entries: Entry[] }) {
  const ages = ageByTarget(entries, Date.now())
  if (ages.length === 0) return null
  return (
    <section className={styles.ages} aria-label="How old each destination is">
      <h2>Oldest copy at each destination</h2>
      <ul>
        {ages.map((age) => {
          const late = age.ageMs > age.limitMs
          const text = `${spanText(age.ageMs)} old, late after ${spanText(age.limitMs)}`
          return (
            <li key={age.target} data-late={late ? 'true' : undefined}>
              <span className={styles.agesName}>{title(age.target)}</span>
              <span
                className={styles.agesTrack}
                role="img"
                aria-label={`${title(age.target)}: ${text}`}
              >
                <span
                  className={styles.agesFill}
                  style={{
                    width: `${Math.min(100, Math.max(2, (age.ageMs / age.limitMs) * 100))}%`,
                  }}
                />
              </span>
              <span className={styles.agesText}>
                {text}
                {age.copies > 1 ? ` (${age.name})` : ''}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function BackupsPage() {
  // When the whole server is down the offline strip's Retry is the only one.
  const down = useServerReach().down
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(''),
    [loadedAt, setLoadedAt] = useState<number | null>(null),
    [search, setSearch] = useState('')
  const load = useCallback(() => {
    api<Overview>('/api/backups')
      .then((value) => {
        setData(value)
        setLoadedAt(Date.now())
        setError('')
      })
      .catch((error) => setError(error.message))
  }, [])
  useEffect(() => {
    load()
    const timer = setInterval(load, 15000)
    return () => clearInterval(timer)
  }, [load])
  const { busy, message, run } = useBackupRun(load)
  const needle = search.trim().toLowerCase()
  const rows = data?.entries.filter(
    (row) =>
      !needle ||
      `${row.name} ${title(row.target)} ${machineLabel(row.machine)} ${row.machine} ${row.meaning}`
        .toLowerCase()
        .includes(needle),
  )
  const groups = rows ? groupBySource(rows) : []
  const live = groups.filter((group) => group.state !== 'off')
  const archived = groups.filter(
    (group) => group.state === 'off' && group.retired,
  )
  const away = groups.filter((group) => group.state === 'off' && !group.retired)
  const machines = new Set(data?.entries.map((row) => row.machine))
  const manyMachines = machines.size > 1
  const runnable = runnableTargets(data?.entries ?? [])
  return (
    <main className={styles.page} data-testid="backups-page">
      <Header />
      {error && (
        <div role="alert" className={styles.notice}>
          <p>
            {data
              ? `Can't refresh the list. Showing what was read at ${new Date(loadedAt ?? Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
              : `Can't read backups. ${error}`}
          </p>
          {!down && (
            <button
              type="button"
              className="lantern-btn ghost small"
              onClick={load}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {!data && !error && <p role="status">Loading backups…</p>}
      {data && (
        <>
          <p
            className={styles.summary}
            role="status"
            data-testid="backups-summary"
          >
            {backupSummary(data.entries)}
          </p>
          <p className={styles.help}>
            Last good data, where it is kept, and when the next copy runs.
          </p>
          <AgeChart entries={data.entries} />
          {message && (
            <p role="status" className={styles.notice}>
              {message}
            </p>
          )}
          <div className={styles.toolbar}>
            <label>
              Find a backup
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, destination or machine"
              />
            </label>
            {runnable.length > 0 && (
              <div
                className={styles.actions}
                role="group"
                aria-label="Back up now"
              >
                {runnable.map((target) => (
                  <button
                    key={target}
                    type="button"
                    className="lantern-btn small"
                    disabled={!!busy}
                    onClick={() => run(target)}
                  >
                    {busy === target
                      ? `Starting ${title(target)}…`
                      : `Back up to ${title(target)} now`}
                  </button>
                ))}
              </div>
            )}
          </div>
          {groups.length === 0 ? (
            <p>
              {search
                ? 'No backups match your search.'
                : 'No backups are registered on this machine yet.'}
            </p>
          ) : (
            <>
              <ul className={styles.groups}>
                {live.map((group) => (
                  <Group
                    key={group.source}
                    group={group}
                    machine={manyMachines}
                  />
                ))}
              </ul>
              {away.length > 0 && (
                <details className={styles.archived} open>
                  <summary>
                    On a machine that is off ({away.length}): new copies wait
                    until it is back
                  </summary>
                  <ul className={styles.groups}>
                    {away.map((group) => (
                      <Group
                        key={group.source}
                        group={group}
                        machine={manyMachines}
                      />
                    ))}
                  </ul>
                </details>
              )}
              {archived.length > 0 && (
                <details className={styles.archived}>
                  <summary>
                    Archived ({archived.length}): their source is gone, older
                    copies are kept
                  </summary>
                  <ul className={styles.groups}>
                    {archived.map((group) => (
                      <Group
                        key={group.source}
                        group={group}
                        machine={manyMachines}
                      />
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      )}
    </main>
  )
}
export function RestorePage() {
  const [source, setSource] = useState(''),
    [sourceName, setSourceName] = useState('Selected backup'),
    [target, setTarget] = useState<Target>('drive'),
    [snapshots, setSnapshots] = useState<Snapshot[] | null>(null),
    [snapshot, setSnapshot] = useState(''),
    [path, setPath] = useState('/'),
    [nodes, setNodes] = useState<FileNode[] | null>(null),
    [to, setTo] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const load = useCallback((s: string, t: string) => {
    setSnapshots(null)
    setError('')
    api<Snapshot[]>(
      `/api/backups/snapshots?source=${encodeURIComponent(s)}&target=${t}`,
    )
      .then((list) => {
        setSnapshots(list)
        if (list[0]) {
          setSnapshot(list[0].id)
          setPath(list[0].paths[0] || '/')
        }
      })
      .catch((error) => setError(error.message))
  }, [])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search),
      s = params.get('source') || '',
      t =
        params.get('target') === 'native'
          ? 'native'
          : params.get('target') === 'append'
            ? 'append'
            : 'drive'
    setSource(s)
    setSourceName(params.get('name') || 'Selected backup')
    setTarget(t)
    setTo(`/srv/scratch/aico-restore-${Date.now()}`)
    if (s) load(s, t)
    else setError('Open a backup from the Backups list to choose its source.')
  }, [load])
  async function browse() {
    setBusy(true)
    setError('')
    setNodes(null)
    try {
      setNodes(
        await api<FileNode[]>(
          `/api/backups/browse?${new URLSearchParams({ source, target, snapshot, path })}`,
        ),
      )
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function restore() {
    setBusy(true)
    setError('')
    setMessage('Restoring and checking the files…')
    try {
      const result = await api<{ destination: string }>(
        '/api/backups/restore',
        { source, target, snapshot, path, to },
      )
      setMessage(`Restored and verified in ${result.destination}.`)
    } catch (error) {
      setError((error as Error).message)
      setMessage('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className={styles.page}>
      <Header restore />
      <p className={styles.help}>
        {sourceName} · {title(target)}. Restore into a new scratch folder, then
        review the files.
      </p>
      {error && (
        <div role="alert" className={styles.notice}>
          <p>{error}</p>
          {source && (
            <button
              className="lantern-btn ghost small"
              onClick={() => load(source, target)}
            >
              Reload snapshots
            </button>
          )}
        </div>
      )}
      {source && !snapshots && !error && (
        <p role="status">Loading restorable snapshots…</p>
      )}
      {snapshots?.length === 0 && (
        <p>No restorable snapshots were found for this source.</p>
      )}
      {!!snapshots?.length && (
        <section className={styles.restore}>
          <label>
            Snapshot
            <select
              value={snapshot}
              onChange={(e) => {
                setSnapshot(e.target.value)
                setNodes(null)
                setPath(
                  snapshots.find((s) => s.id === e.target.value)?.paths[0] ||
                    '/',
                )
              }}
            >
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {when(s.time)}
                </option>
              ))}
            </select>
          </label>
          <label>
            File or folder
            <input value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          <button
            className="lantern-btn ghost small"
            disabled={busy}
            onClick={browse}
          >
            {busy ? 'Working…' : 'Browse folder'}
          </button>
          {nodes && (
            <ul className={styles.files}>
              {nodes.length === 0 ? (
                <li>This folder has no entries.</li>
              ) : (
                nodes.map((n) => (
                  <li key={n.path}>
                    <button
                      className="lantern-btn ghost small"
                      onClick={() => setPath(n.path)}
                    >
                      {n.name || n.path}
                      {n.type === 'dir' ? '/' : ''}
                    </button>
                    <small>
                      {n.type === 'dir' ? 'Folder' : `${n.size ?? 0} bytes`}
                    </small>
                  </li>
                ))
              )}
            </ul>
          )}
          <label>
            New scratch folder
            <input value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button
            className="lantern-btn small"
            disabled={busy || !path || !to}
            onClick={restore}
          >
            Restore files
          </button>
        </section>
      )}
      {message && (
        <p role="status" className={styles.notice}>
          {message}
        </p>
      )}
    </main>
  )
}
