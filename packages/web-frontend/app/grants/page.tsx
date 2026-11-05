'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import styles from '@/components/BackupsPage.module.css'

interface View {
  requests: {
    id: string
    title: string
    reason: string
    agent: string
    state: string
    expires: number
  }[]
  uses: { at: number; event: string; id: string; kind: string; uid: number }[]
  labels: Record<string, string>
}
const when = (at: number) => new Date(at * 1000).toLocaleString()

export default function GrantsPage() {
  const [data, setData] = useState<View | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/grants', { cache: 'no-store' })
      if (!response.ok) throw new Error('Grants could not be read. Try again.')
      setData(await response.json())
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  async function revoke(id: string) {
    setBusy(id)
    try {
      const response = await fetch('/api/grants/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!response.ok) throw new Error('Access could not be ended. Try again.')
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  return (
    <main className={styles.page}>
      <header>
        <Link className="lantern-btn ghost small" href="/">
          Sessions
        </Link>
        <h1>Grants</h1>
        <button
          className="lantern-btn ghost small"
          type="button"
          onClick={() => void load()}
        >
          Refresh
        </button>
      </header>
      <p>
        Approve access with your security key in the Aico tray. End access here
        at any time.
      </p>
      {error && (
        <p role="alert" className={styles.notice}>
          {error}
          {data ? ' Showing the last read.' : ''}
        </p>
      )}
      {!data && !error && <p role="status">Loading grants…</p>}
      {data && (
        <>
          <h2>Access</h2>
          {!data.requests.length && <p>No access requests yet.</p>}
          <ul className={styles.rows}>
            {[...data.requests].reverse().map((r) => (
              <li key={r.id} id={r.id}>
                <div>
                  <strong>{r.title}</strong>
                  <p>{r.reason}</p>
                  <small>{r.agent || 'An agent'}</small>
                </div>
                <div>
                  <span className="lantern-chip">
                    {r.state === 'approved'
                      ? 'Open'
                      : r.state === 'pending'
                        ? 'Needs your tap'
                        : r.state.charAt(0).toUpperCase() + r.state.slice(1)}
                  </span>
                  <p>
                    <small>
                      {r.state === 'approved'
                        ? `Ends ${when(r.expires)}`
                        : r.state === 'pending'
                          ? `Tap before ${when(r.expires)}`
                          : 'Access closed.'}
                    </small>
                  </p>
                </div>
                {['pending', 'approved'].includes(r.state) && (
                  <button
                    className="lantern-btn ghost small"
                    type="button"
                    disabled={busy === r.id}
                    onClick={() => void revoke(r.id)}
                  >
                    {busy === r.id
                      ? 'Ending…'
                      : r.state === 'pending'
                        ? 'Withdraw'
                        : 'End access'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <h2>Use log</h2>
          <p>Each use records the access, time and local user.</p>
          {!data.uses.some((u) => u.event === 'use') && (
            <p>No uses recorded yet.</p>
          )}
          <ul className={styles.rows}>
            {data.uses
              .filter((u) => u.event === 'use')
              .map((u) => (
                <li key={`${u.at}-${u.id}-${u.event}`}>
                  <strong>{data.labels[u.kind] || u.kind}</strong>
                  <span>Used · user {u.uid}</span>
                  <time dateTime={new Date(u.at * 1000).toISOString()}>
                    {when(u.at)}
                  </time>
                </li>
              ))}
          </ul>
        </>
      )}
    </main>
  )
}
