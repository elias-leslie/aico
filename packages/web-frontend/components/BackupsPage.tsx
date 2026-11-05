'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import styles from './BackupsPage.module.css'

type Target = 'native' | 'drive' | 'append' | 'external'
interface Entry {
  id: string
  source: string
  name: string
  target: Target
  dataAt: string | null
  nextRun: string | null
  state: string
  meaning: string
  snapshot: string | null
  path: string | null
  machine: string
  running?: boolean
}
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
const title = (target: Target) =>
  target === 'native'
    ? 'T7'
    : target === 'drive'
      ? 'Drive'
      : target === 'append'
        ? 'CT 160'
        : 'Owner backup'
const when = (time: string | null) =>
  time ? new Date(time).toLocaleString() : 'Not recorded'
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  )
  const value = await response.json()
  if (!response.ok)
    throw new Error(
      value.detail || value.error || `Aico answered ${response.status}.`,
    )
  return value as T
}
function Header({ restore = false }: { restore?: boolean }) {
  return (
    <header>
      <Link
        className="lantern-btn ghost small"
        href={restore ? '/backups' : '/'}
      >
        {restore ? 'Backups' : 'Sessions'}
      </Link>
      <h1>{restore ? 'Restore files' : 'Backups'}</h1>
      <Link className="lantern-btn ghost small" href="/status?kind=backup">
        Status
      </Link>
    </header>
  )
}
export function BackupsPage() {
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState<Target | null>(null),
    [search, setSearch] = useState('')
  const load = useCallback(() => {
    api<Overview>('/api/backups')
      .then((value) => {
        setData(value)
        setError('')
      })
      .catch((error) => setError(error.message))
  }, [])
  useEffect(() => {
    load()
    const timer = setInterval(load, 15000)
    return () => clearInterval(timer)
  }, [load])
  async function run(target: Target) {
    setBusy(target)
    setMessage('')
    try {
      const result = await api<{ message: string }>('/api/backups/run', {
        target,
      })
      setMessage(result.message)
      load()
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const rows = data?.entries.filter((row) =>
    `${row.name} ${title(row.target)} ${row.machine} ${row.meaning}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  return (
    <main className={styles.page}>
      <Header />
      <p className={styles.help}>
        Last good data, where it is kept, and when the next copy runs.
      </p>
      {error && (
        <div role="alert" className={styles.notice}>
          <p>
            {data
              ? 'The list could not refresh. Showing the last loaded data.'
              : error}
          </p>
          <button className="lantern-btn ghost small" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {!data && !error && <p role="status">Loading backups…</p>}
      {message && (
        <p role="status" className={styles.notice}>
          {message}
        </p>
      )}
      {data && (
        <>
          <div className={styles.toolbar}>
            <label>
              Find a backup
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, copy or machine"
              />
            </label>
            <span>
              {data.entries.length} backup copies · {data.machine}
            </span>
          </div>
          {rows?.length === 0 ? (
            <p>
              {search
                ? 'No backups match your search.'
                : 'No backups are registered on this machine yet.'}
            </p>
          ) : (
            <ul className={styles.rows}>
              {rows?.map((row) => (
                <li key={row.id}>
                  <div>
                    <strong>{row.name}</strong>
                    <small>
                      {title(row.target)} · {row.machine}
                    </small>
                    <p>{row.meaning}</p>
                    <small>
                      Last good data: {when(row.dataAt)}
                      <br />
                      Next run: {when(row.nextRun)}
                    </small>
                  </div>
                  <span className={styles.badge} data-state={row.state}>
                    {row.running
                      ? 'Copying…'
                      : row.state === 'ok'
                        ? 'Current'
                        : row.state === 'failed'
                          ? 'Failed'
                          : row.state === 'off'
                            ? 'Off'
                            : 'Needs a fresh copy'}
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
                      <button
                        className="lantern-btn ghost small"
                        disabled={!!busy}
                        onClick={() => run(row.target)}
                      >
                        {busy === row.target ? 'Making due…' : 'Run now'}
                      </button>
                    )}
                    {row.target !== 'external' && (
                      <Link
                        className="lantern-btn ghost small"
                        href={`/backups/restore?source=${encodeURIComponent(row.source)}&target=${row.target}&name=${encodeURIComponent(row.name)}`}
                      >
                        Open restore
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
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
