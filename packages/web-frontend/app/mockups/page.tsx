'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { OfflineBanner, ReadOnlyScope } from '@/components/ReadOnly'
import { apiFetch } from '@/lib/api-fetch'
import styles from './page.module.css'

interface Mockup {
  id: string
  project: string
  title: string
  note: string
  session: string | null
  askId: string
  createdAt: string
  selectedAt: string | null
  state: 'pending' | 'selected' | 'passed'
  htmlUrl: string
}

function MockupCard({
  item,
  changed,
}: {
  item: Mockup
  changed: (item: Mockup) => void
}) {
  const [note, setNote] = useState(item.note)
  const [working, setWorking] = useState<'save' | 'select' | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [previewFailed, setPreviewFailed] = useState(false)
  useEffect(() => {
    setNote(item.note)
  }, [item.note])
  const pending = item.state === 'pending'
  const act = async (action: 'save' | 'select') => {
    setWorking(action)
    setError('')
    setMessage('')
    try {
      const query = `?project=${encodeURIComponent(item.project)}`
      const result = await apiFetch<{ mockup: Mockup }>(
        `/api/mockups/${item.id}${action === 'select' ? '/select' : ''}${query}`,
        {
          method: action === 'select' ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        },
        action === 'select'
          ? 'The choice could not be sent'
          : 'The note could not be saved',
      )
      changed(result.mockup)
      setMessage(action === 'select' ? 'Choice saved.' : 'Note saved.')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The change could not be saved',
      )
    } finally {
      setWorking(null)
    }
  }
  return (
    <article className={styles.card} aria-labelledby={`mockup-${item.id}`}>
      <header className={styles.cardHeader}>
        <h2 id={`mockup-${item.id}`}>{item.title}</h2>
        <span className={styles.chip} data-selected={item.state === 'selected'}>
          {item.state === 'selected'
            ? 'Selected'
            : item.state === 'passed'
              ? 'Not selected'
              : 'Pending'}
        </span>
      </header>
      {previewFailed ? (
        <p role="alert" className={styles.notice}>
          The preview could not load. Refresh to try again.
        </p>
      ) : (
        <iframe
          className={styles.preview}
          title={`Preview: ${item.title}`}
          src={item.htmlUrl}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setPreviewFailed(true)}
        />
      )}
      <div className={styles.review}>
        <label htmlFor={`note-${item.id}`}>Note</label>
        <textarea
          id={`note-${item.id}`}
          value={note}
          maxLength={1000}
          rows={3}
          disabled={!pending || working !== null}
          onChange={(event) => {
            setNote(event.target.value)
            setMessage('')
          }}
          aria-label={`Note for ${item.title}`}
        />
        <div className={styles.actions}>
          {pending && (
            <>
              <button
                className="lantern-btn small"
                disabled={working !== null || note === item.note}
                onClick={() => void act('save')}
              >
                {working === 'save' ? 'Saving…' : 'Save note'}
              </button>
              <button
                className="lantern-btn primary"
                disabled={working !== null}
                onClick={() => void act('select')}
              >
                {working === 'select' ? 'Sending…' : 'Use this one'}
              </button>
            </>
          )}
          {message && <p role="status">{message}</p>}
        </div>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </article>
  )
}

function Mockups() {
  const project = useSearchParams().get('project')?.trim() ?? ''
  const [items, setItems] = useState<Mockup[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit Refresh trigger
  useEffect(() => {
    let current = true
    setItems(null)
    setError('')
    setLoading(true)
    if (!project) {
      setLoading(false)
      return
    }
    void apiFetch<{ items: Mockup[] }>(
      `/api/mockups?project=${encodeURIComponent(project)}`,
      { cache: 'no-store' },
      'Mockups could not load',
    )
      .then((data) => {
        if (current) setItems(data.items)
      })
      .catch((cause: unknown) => {
        if (current)
          setError(
            cause instanceof Error ? cause.message : 'Mockups could not load',
          )
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [project, revision])
  const changed = useCallback((updated: Mockup) => {
    setItems(
      (previous) =>
        previous?.map((item) => {
          if (item.id === updated.id) return updated
          return updated.state === 'selected' && item.askId === updated.askId
            ? { ...item, state: 'passed' }
            : item
        }) ?? null,
    )
  }, [])
  return (
    <main className={styles.page}>
      <OfflineBanner />
      <ReadOnlyScope>
        <header className={styles.header}>
          <Link href="/" className="lantern-btn ghost small">
            Sessions
          </Link>
          <div>
            <h1>Mockups</h1>
            {project && <p>{project}</p>}
          </div>
          {project && (
            <button
              className="lantern-btn small"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh
            </button>
          )}
        </header>
        {!project ? (
          <p className={styles.notice}>
            Open a project&apos;s mockup link to review its designs.
          </p>
        ) : loading ? (
          <p role="status" className={styles.notice}>
            Loading mockups…
          </p>
        ) : error ? (
          <p role="alert" className={styles.notice}>
            {error}. Use Refresh to try again.
          </p>
        ) : items?.length === 0 ? (
          <p className={styles.notice}>No mockups for this project yet.</p>
        ) : (
          <>
            <p className={styles.help}>
              Add a note, then choose a mockup. Your note goes with the choice.
            </p>
            <div className={styles.list}>
              {items?.map((item) => (
                <MockupCard key={item.id} item={item} changed={changed} />
              ))}
            </div>
          </>
        )}
      </ReadOnlyScope>
    </main>
  )
}

export default function MockupsPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className={styles.notice}>
          Loading mockups…
        </p>
      }
    >
      <Mockups />
    </Suspense>
  )
}
