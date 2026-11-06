'use client'

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { ConfirmationDialog } from './ConfirmationDialog'
import styles from './MemorySection.module.css'
import { PlainMarkdown } from './PlainMarkdown'

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
  return (
    <li>
      <details>
        <summary>
          <span className={styles.name}>{title(memory)}</span>
          <span className={styles.chips}>
            <span className={styles.chip}>{tierText[memory.tier]}</span>
            <span className={styles.chip}>{scopeText(memory)}</span>
          </span>
        </summary>
        <PlainMarkdown className={styles.body} text={memory.content} />
        {memory.tags.length > 0 && (
          <p className={styles.meta}>Tags: {memory.tags.join(', ')}</p>
        )}
        <p className={styles.meta}>
          Updated {new Date(memory.updatedAt).toLocaleString()}
        </p>
      </details>
      <button
        type="button"
        className={`lantern-icon-btn ${styles.danger}`}
        aria-label={`Delete memory: ${title(memory)}`}
        onClick={onDelete}
      >
        <Trash2 size={16} />
      </button>
    </li>
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
    <section className={styles.section} aria-label="Memories">
      <h2>Memories</h2>
      <p className={styles.help}>
        What agents are told to remember. Deleting one stops it reaching new
        sessions.
      </p>
      <div className={styles.filters}>
        <label className={styles.grow}>
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
      </div>
      {query.isPending && <p role="status">Loading memories…</p>}
      {query.isError && (
        <p role="alert">
          {rows.length
            ? 'Could not refresh memories. Showing the last loaded list.'
            : 'Could not load memories.'}{' '}
          <button
            type="button"
            className="lantern-btn small"
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </p>
      )}
      {query.isSuccess && rows.length === 0 && (
        <p>
          {filtered
            ? 'No memories match. Clear the search or kind to see them all.'
            : 'No memories saved yet.'}
        </p>
      )}
      {rows.length > 0 && (
        <ul className={styles.list} aria-label="Memory list">
          {rows.map((m) => (
            <Memory key={m.id} memory={m} onDelete={() => setDoomed(m)} />
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <button
          type="button"
          className="lantern-btn"
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
