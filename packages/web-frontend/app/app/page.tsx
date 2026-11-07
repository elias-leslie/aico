'use client'

import { useCallback, useEffect, useState } from 'react'
import styles from '@/components/BackupsPage.module.css'
import { shortWhen } from '@/lib/short-when'
import { at } from '@/lib/status'

interface View {
  published: boolean
  phones: { id: string; name: string; last_ack: number | null }[] | null
}

export default function PhoneAppPage() {
  const [data, setData] = useState<View | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pair, setPair] = useState<{ link: string; expires: number } | null>(
    null,
  )
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/phone-app', { cache: 'no-store' })
      if (!response.ok)
        throw new Error('Phone details could not be read. Try again.')
      setData(await response.json())
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  async function pairPhone() {
    setBusy(true)
    setPair(null)
    setError('')
    try {
      const response = await fetch('/api/phone-pair', { method: 'POST' })
      const result = await response.json()
      if (!response.ok)
        throw new Error(result.error || 'Pairing could not start. Try again.')
      setPair({
        link: result.link,
        expires: Date.now() + result.expires_in * 1000,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!pair) return
    const timer = setTimeout(
      () => setPair(null),
      Math.max(0, pair.expires - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [pair])
  return (
    <main className={styles.page}>
      <header>
        <h1>Phone app</h1>
        <button
          className="lantern-btn ghost small"
          type="button"
          onClick={() => void load()}
        >
          Refresh
        </button>
      </header>
      <p>
        Install Aico on your Android phone to get alerts and answer requests.
      </p>
      {error && (
        <p className={styles.notice} role="alert">
          {error}
          {data ? ' Showing the last read.' : ''}
        </p>
      )}
      {!data && !error && <p role="status">Loading phone details…</p>}
      {data && (
        <>
          {data.published ? (
            <p>
              <a className="lantern-btn small" href="/app/aico.apk">
                Download the app
              </a>
            </p>
          ) : (
            <p>The app download is not available yet.</p>
          )}
          <p>Open this page on your phone after installing the app.</p>
          <button
            className="lantern-btn small"
            type="button"
            disabled={busy}
            onClick={() => void pairPhone()}
          >
            {busy ? 'Starting pairing…' : 'Pair this phone'}
          </button>
          {pair && (
            <p>
              <a className="lantern-btn small" href={pair.link}>
                Open in the app
              </a>{' '}
              This pairing link expires at {at(pair.expires, Date.now())}.
            </p>
          )}
          <h2>Paired phones</h2>
          {data.phones === null ? (
            <p role="alert">
              Paired phones could not be read. Refresh to try again.
            </p>
          ) : data.phones.length === 0 ? (
            <p>No phones paired yet.</p>
          ) : (
            <ul className={styles.rows}>
              {data.phones.map((phone) => (
                <li key={phone.id}>
                  <strong>{phone.name}</strong>
                  <small>
                    {phone.last_ack
                      ? `Last heard ${shortWhen(phone.last_ack * 1000)}`
                      : 'No confirmation received yet.'}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  )
}
