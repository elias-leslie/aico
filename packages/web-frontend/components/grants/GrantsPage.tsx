'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { formatWhen } from '@/lib/capture-format'
import {
  type GrantItem,
  type GrantsView,
  grantsLine,
  grantUseLine,
  splitGrants,
} from '@/lib/grants'
import { useClock } from '@/lib/hooks/use-clock'
import {
  Actions,
  type Chip,
  Group,
  Notice,
  Quiet,
  Row,
  SectionHead,
} from '../settings/kit'

const GRANTS_KEY = ['grants']
/** A request can arrive or run out while the page is open. */
const GRANTS_POLL_MS = 15_000

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
  const uses = data?.uses ?? []

  return (
    <section aria-label="Grants">
      <SectionHead
        title="Grants"
        sub={
          query.isPending
            ? 'Loading grants…'
            : split
              ? grantsLine(split.active)
              : 'Not loaded'
        }
      >
        <button
          type="button"
          className="lantern-btn small"
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
      </SectionHead>

      {query.isError && (
        <Notice
          failed
          actions={
            <button
              type="button"
              className="lantern-btn small"
              onClick={() => void query.refetch()}
            >
              Try again
            </button>
          }
        >
          <b>Couldn’t read grants.</b>{' '}
          {data
            ? `Showing the last read from ${formatWhen(query.dataUpdatedAt, now)}.`
            : 'Nothing below counts as open or closed until it loads.'}
        </Notice>
      )}
      {revokeError && <Notice failed>{revokeError}</Notice>}

      {split && (
        <>
          <Group title="Active" count={split.active.length}>
            {split.active.length === 0 ? (
              <Quiet>
                A request shows up here when an agent asks for access.
              </Quiet>
            ) : (
              split.active.map((item) => (
                <GrantRow
                  key={item.request.id}
                  item={item}
                  busy={revoking === item.request.id}
                  used={grantUseLine(item, uses, now)}
                  onEnd={() => void end(item)}
                />
              ))
            )}
          </Group>

          <Group title="History" count={split.history.length}>
            {split.history.length === 0 ? (
              <Quiet>Nothing has expired or ended yet.</Quiet>
            ) : (
              split.history.map((item) => (
                <GrantRow
                  key={item.request.id}
                  item={item}
                  busy={false}
                  used={grantUseLine(item, uses, now)}
                  onEnd={() => undefined}
                />
              ))
            )}
          </Group>
        </>
      )}
    </section>
  )
}

/** A request: its title, who asked and when, and a state chip. Open ones start open, with their one action. */
function GrantRow({
  item,
  busy,
  used,
  onEnd,
}: {
  item: GrantItem
  busy: boolean
  /** How it was used, folded into one line. */
  used: string | null
  onEnd: () => void
}) {
  const { request } = item
  return (
    <Row
      id={request.id}
      name={item.title}
      meta={`${request.agent || 'An agent'} · ${item.when}`}
      chip={CHIP[item.kind] as Chip}
      chipText={item.chip}
      defaultOpen={item.live}
    >
      {request.reason && <p>{request.reason}</p>}
      {used && <small>{used}</small>}
      {item.live ? (
        <Actions>
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
        </Actions>
      ) : (
        !request.reason && !used && <small>No reason was given.</small>
      )}
    </Row>
  )
}
