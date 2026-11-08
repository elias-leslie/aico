'use client'

import { useCallback, useEffect, useState } from 'react'
import { shortWhen } from '@/lib/short-when'
import { at } from '@/lib/status'
import { Actions, Group, Notice, Quiet, Row, SectionHead } from './kit'

interface View {
  published: boolean
  phones: { id: string; name: string; last_ack: number | null }[] | null
}

/** Phone app: where to get the Android app, a pairing link, and the phones already paired. */
export function PhoneAppSection() {
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
    <section aria-label="Phone app">
      <SectionHead
        title="Phone app"
        sub="Install Aico on your Android phone to get alerts and answer requests."
      >
        <button
          className="lantern-btn small"
          type="button"
          onClick={() => void load()}
        >
          Refresh
        </button>
      </SectionHead>
      {error && (
        <Notice failed>
          {error}
          {data ? ' Showing the last read.' : ''}
        </Notice>
      )}
      {!data && !error && <Quiet role="status">Loading phone details…</Quiet>}
      {data && (
        <>
          <Group title="Set up">
            <Row
              name="Install the app"
              meta={
                data.published
                  ? 'Android. Open this page on your phone after installing.'
                  : 'The app download is not available yet.'
              }
              chip={data.published ? 'ok' : 'off'}
              chipText={data.published ? 'Ready' : 'Not yet'}
              defaultOpen={data.published}
            >
              {data.published ? (
                <Actions>
                  <a className="lantern-btn small" href="/app/aico.apk">
                    Download the app
                  </a>
                </Actions>
              ) : (
                <small>Nothing to download until the app is published.</small>
              )}
            </Row>
            <Row
              name="Pair this phone"
              meta="Makes a link that opens the app and signs it in."
              defaultOpen
            >
              <Actions>
                <button
                  className="lantern-btn small"
                  type="button"
                  disabled={busy}
                  onClick={() => void pairPhone()}
                >
                  {busy ? 'Starting pairing…' : 'Pair this phone'}
                </button>
                {pair && (
                  <a className="lantern-btn small" href={pair.link}>
                    Open in the app
                  </a>
                )}
              </Actions>
              {pair && (
                <small>
                  This pairing link expires at {at(pair.expires, Date.now())}.
                </small>
              )}
            </Row>
          </Group>
          <Group
            title="Paired phones"
            count={data.phones?.length}
            label="Paired phones"
          >
            {data.phones === null ? (
              <Quiet role="alert">
                Paired phones could not be read. Refresh to try again.
              </Quiet>
            ) : data.phones.length === 0 ? (
              <Quiet>No phones paired yet.</Quiet>
            ) : (
              data.phones.map((phone) => (
                <Row
                  key={phone.id}
                  name={phone.name}
                  meta={
                    phone.last_ack
                      ? `Last heard ${shortWhen(phone.last_ack * 1000)}`
                      : 'No confirmation received yet.'
                  }
                />
              ))
            )}
          </Group>
        </>
      )}
    </section>
  )
}
