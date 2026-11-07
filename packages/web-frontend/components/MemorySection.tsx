'use client'

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { shortWhen } from '@/lib/short-when'
import { ConfirmationDialog } from './ConfirmationDialog'
import { PlainMarkdown } from './PlainMarkdown'
import { Form, Group, Notice, Quiet, Row } from './settings/kit'
import kit from './settings/kit.module.css'

type Tier = 'mandate' | 'guardrail' | 'reference' | 'archive'
type Scope = 'global' | 'project' | 'agent'
interface MemoryRow {
  id: string
  scope: Scope
  scopeId: string
  tier: Tier
  summary: string
  content: string
  tags: string[]
  updatedAt: string
}
interface MemoryPage {
  memories: MemoryRow[]
  next: number | null
}

const tierText: Record<Tier, string> = {
  mandate: 'Mandate',
  guardrail: 'Guardrail',
  reference: 'Reference',
  archive: 'Archived',
}
const scopeText = (m: MemoryRow) =>
  m.scope === 'global'
    ? 'All sessions'
    : `${m.scope === 'project' ? 'Project' : 'Agent'} ${m.scopeId}`
const title = (m: MemoryRow) =>
  m.summary.trim() || m.content.trim().split('\n')[0] || 'Untitled memory'

function Memory({
  memory,
  onDelete,
}: {
  memory: MemoryRow
  onDelete: () => void
}) {
  const archived = memory.tier === 'archive'
  return (
    <Row
      name={title(memory)}
      meta={
        archived
          ? scopeText(memory)
          : `${tierText[memory.tier]} · ${scopeText(memory)}`
      }
      chip={archived ? 'off' : undefined}
      chipText={archived ? tierText.archive : undefined}
    >
      <PlainMarkdown className={kit.prose} text={memory.content} />
      {memory.tags.length > 0 && <small>Tags: {memory.tags.join(', ')}</small>}
      <small>Updated {shortWhen(memory.updatedAt)}</small>
      <div>
        <button
          type="button"
          className="lantern-btn danger small"
          aria-label={`Delete memory: ${title(memory)}`}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </Row>
  )
}

export function MemorySection() {
  const client = useQueryClient()
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [tier, setTier] = useState('')
  const [doomed, setDoomed] = useState<MemoryRow | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 250)
    return () => clearTimeout(t)
  }, [typed])
  const query = useInfiniteQuery({
    queryKey: ['memories', search, tier],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ offset: String(pageParam) })
      if (search) p.set('q', search)
      if (tier) p.set('tier', tier)
      return apiFetch<MemoryPage>(`/api/memories?${p}`)
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const remove = useMutation({
    mutationFn: (m: MemoryRow) =>
      apiFetch(`/api/memories/${encodeURIComponent(m.id)}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      setDoomed(null)
      await client.invalidateQueries({ queryKey: ['memories'] })
    },
  })
  const rows = query.data?.pages.flatMap((p) => p.memories) ?? []
  const filtered = Boolean(search || tier)
  return (
    <section aria-label="Memories">
      <Quiet>
        What agents are told to remember. Deleting one stops it reaching new
        sessions.
      </Quiet>
      <Form onSubmit={(e) => e.preventDefault()}>
        <label>
          Search
          <input
            type="search"
            value={typed}
            placeholder="Words in a memory"
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        <label>
          Kind
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">All</option>
            {(Object.keys(tierText) as Tier[]).map((t) => (
              <option key={t} value={t}>
                {tierText[t]}
              </option>
            ))}
          </select>
        </label>
      </Form>
      {query.isPending && <Quiet role="status">Loading memories…</Quiet>}
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
          {rows.length
            ? 'Could not refresh memories. Showing the last loaded list.'
            : 'Could not load memories.'}
        </Notice>
      )}
      {query.isSuccess && rows.length === 0 && (
        <Quiet>
          {filtered
            ? 'No memories match. Clear the search or kind to see them all.'
            : 'No memories saved yet.'}
        </Quiet>
      )}
      {rows.length > 0 && (
        <Group title="Memories" label="Memory list" count={rows.length}>
          {rows.map((m) => (
            <Memory key={m.id} memory={m} onDelete={() => setDoomed(m)} />
          ))}
        </Group>
      )}
      {query.hasNextPage && (
        <button
          type="button"
          className="lantern-btn small"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
      <ConfirmationDialog
        isOpen={doomed !== null}
        title="Delete this memory?"
        message={
          doomed
            ? `“${title(doomed)}” will stop reaching new sessions. This can't be undone from here.`
            : ''
        }
        confirmText="Delete"
        pendingText="Deleting…"
        isPending={remove.isPending}
        error={
          remove.isError ? `Could not delete: ${remove.error.message}` : null
        }
        onConfirm={() => doomed && remove.mutate(doomed)}
        onCancel={() => {
          remove.reset()
          setDoomed(null)
        }}
      />
    </section>
  )
}
