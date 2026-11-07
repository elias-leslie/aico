'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import styles from '@/components/pages/FullPage.module.css'
import { apiFetch } from '@/lib/api-fetch'
import { formatWhen } from '@/lib/capture-format'
import {
  type GrantItem,
  type GrantsView,
  grantsLine,
  splitGrants,
} from '@/lib/grants'
import { useClock } from '@/lib/hooks/use-clock'

const GRANTS_KEY = ['grants']
/** A request can arrive or run out while the page is open. */
const GRANTS_POLL_MS = 15_000
const USES_SHOWN = 8

const CHIP: Record<GrantItem['kind'], string> = {
  open: 'ok',
  waiting: 'warn',
  ended: 'off',
  expired: 'off',
  withdrawn: 'off',
  denied: 'off',
}

/** Grants: access agents asked for. Active (open and waiting), then History. */
export function GrantsPage() {
  const now = useClock(30_000)
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: GRANTS_KEY,
    queryFn: () =>
      apiFetch<GrantsView>(
        '/api/grants',
        { cache: 'no-store' },
        'Couldn’t read grants',
      ),
    refetchInterval: GRANTS_POLL_MS,
    retry: 1,
  })
  const [allUses, setAllUses] = useState(false)
  const [revoking, setRevoking] = useState('')
  const [revokeError, setRevokeError] = useState('')
  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiFetch(
        '/api/grants/revoke',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        },
        'Couldn’t end that access',
      ),
  })

  async function end(item: GrantItem) {
    setRevoking(item.request.id)
    setRevokeError('')
    try {
      await revoke.mutateAsync(item.request.id)
      await queryClient.invalidateQueries({ queryKey: GRANTS_KEY })
    } catch (e) {
      setRevokeError(
        `${(e as Error).message}. It is still ${item.kind === 'waiting' ? 'waiting' : 'open'}.`,
      )
    } finally {
      setRevoking('')
    }
  }

  const data = query.data
  const split = data ? splitGrants(data, now) : null
  const uses = data ? data.uses.filter((u) => u.event === 'use') : []
  const shownUses = allUses ? uses : uses.slice(0, USES_SHOWN)

  return (
    <main className={styles.page} aria-label="Grants">
      <div className={styles.inner}>
        <div className={styles.head}>
          <h1>Grants</h1>
          <button
            type="button"
            className="lantern-btn ghost small"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              className="h-3.5 w-3.5"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            {query.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <p className={styles.sum} role="status">
          {query.isPending
            ? 'Loading grants…'
            : split
              ? grantsLine(split.active)
              : 'Not loaded'}
        </p>

        {query.isError && (
          <div className={`${styles.notice} ${styles.bad}`} role="alert">
            <p>
              <b>Couldn’t read grants.</b>{' '}
              {data
                ? `Showing the last read from ${formatWhen(query.dataUpdatedAt, now)}.`
                : 'Nothing below counts as open or closed until it loads.'}
            </p>
            <button
              type="button"
              className="lantern-btn small"
              onClick={() => void query.refetch()}
            >
              Try again
            </button>
          </div>
        )}
        {revokeError && (
          <div className={`${styles.notice} ${styles.bad}`} role="alert">
            <p>{revokeError}</p>
          </div>
        )}

        {query.isPending && (
          <div className={styles.list} aria-hidden="true">
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </div>
        )}

        {split && (
          <>
            <section className={styles.sec} aria-labelledby="grants-active">
              <h2 id="grants-active">
                Active <span className={styles.n}>{split.active.length}</span>
              </h2>
              {split.active.length === 0 ? (
                <p className={styles.empty}>
                  Nothing is open or waiting. A request shows up here when an
                  agent asks for access.
                </p>
              ) : (
                <ul className={styles.list}>
                  {split.active.map((item) => (
                    <GrantRow
                      key={item.request.id}
                      item={item}
                      busy={revoking === item.request.id}
                      onEnd={() => void end(item)}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.sec} aria-labelledby="grants-history">
              <h2 id="grants-history">
                History <span className={styles.n}>{split.history.length}</span>
              </h2>
              {split.history.length === 0 ? (
                <p className={styles.empty}>
                  Nothing has expired or ended yet.
                </p>
              ) : (
                <ul className={styles.list}>
                  {split.history.map((item) => (
                    <GrantRow
                      key={item.request.id}
                      item={item}
                      busy={false}
                      onEnd={() => undefined}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.sec} aria-labelledby="grants-uses">
              <h2 id="grants-uses">
                Recent use <span className={styles.n}>{uses.length}</span>
              </h2>
              {uses.length === 0 ? (
                <p className={styles.empty}>No access has been used yet.</p>
              ) : (
                <ul className={styles.list}>
                  {shownUses.map((u) => (
                    <li
                      key={`${u.at}-${u.id}`}
                      className={styles.row}
                      style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}
                    >
                      <div className={styles.title}>
                        {data?.labels[u.kind] ?? u.kind}
                      </div>
                      <time
                        className={styles.line}
                        dateTime={new Date(u.at * 1000).toISOString()}
                      >
                        Used {formatWhen(u.at * 1000, now)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
              {uses.length > USES_SHOWN && (
                <button
                  type="button"
                  className={`lantern-btn ghost small ${styles.more}`}
                  onClick={() => setAllUses((v) => !v)}
                >
                  {allUses ? 'Show fewer' : `Show all ${uses.length}`}
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  )
}

function GrantRow({
  item,
  busy,
  onEnd,
}: {
  item: GrantItem
  busy: boolean
  onEnd: () => void
}) {
  const { request } = item
  return (
    <li className={styles.row} id={request.id}>
      <div className={styles.chipCol}>
        <span className={`status-chip ${CHIP[item.kind]}`}>{item.chip}</span>
      </div>
      <div className={styles.main}>
        <div className={styles.title}>{item.title}</div>
        {request.reason && <p className={styles.line}>{request.reason}</p>}
        <p className={`${styles.line}${item.live ? ` ${styles.strong}` : ''}`}>
          {request.agent || 'An agent'} · {item.when}
        </p>
      </div>
      <div className={styles.actions}>
        {item.live && (
          <button
            type="button"
            className="lantern-btn small"
            disabled={busy}
            onClick={onEnd}
          >
            {busy
              ? 'Ending…'
              : item.kind === 'waiting'
                ? 'Withdraw'
                : 'End access'}
          </button>
        )}
      </div>
    </li>
  )
}
