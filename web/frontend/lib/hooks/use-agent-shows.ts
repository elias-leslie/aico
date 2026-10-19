'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'

type ShowMetadata = {
  id: string
  session: string | null
  title: string | null
  name: string
}

export type AgentShow = ShowMetadata &
  ({ kind: 'file' } | { kind: 'url'; url: string })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isShow(value: unknown): value is AgentShow {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{1,64}$/.test(value.id) ||
    !(value.session === null || typeof value.session === 'string') ||
    !(value.title === null || typeof value.title === 'string') ||
    typeof value.name !== 'string'
  ) {
    return false
  }
  if (value.kind === 'file') {
    return /^([0-9a-f]{8}|none)\/out\/[A-Za-z0-9._-]{1,120}$/.test(value.name)
  }
  return (
    value.kind === 'url' &&
    typeof value.url === 'string' &&
    /^https?:\/\//i.test(value.url)
  )
}

function parseShows(value: unknown): AgentShow[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.shows) ||
    value.shows.length > 50
  ) {
    throw new Error('Invalid shared items')
  }
  const items: unknown[] = value.shows
  if (!items.every(isShow)) throw new Error('Invalid shared item')
  return items
}

export function useAgentShows() {
  const [pending, setPending] = useState<AgentShow[]>([])
  const cursor = useRef<string | undefined>(undefined)
  const seen = useRef(new Set<string>())

  useEffect(() => {
    const controller = new AbortController()
    let polling = false
    const requested = new URLSearchParams(window.location.search).get('show')

    async function poll() {
      if (document.visibilityState !== 'visible' || polling) return
      polling = true
      try {
        const query = cursor.current ? `?since=${cursor.current}` : ''
        const payload = await apiFetch<unknown>(`/api/a-term/shows${query}`, {
          signal: controller.signal,
          cache: 'no-store',
        })
        const items = parseShows(payload)
        if (controller.signal.aborted) return
        const fresh = items.filter((item) => !seen.current.has(item.id))
        const last = items.at(-1)
        if (last) cursor.current = last.id
        seen.current = new Set(
          [...seen.current, ...items.map((item) => item.id)].slice(-50),
        )
        const selected = fresh.find((item) => item.id === requested)
        const ordered = selected
          ? [selected, ...fresh.filter((item) => item !== selected)]
          : fresh
        setPending((queue) => [...queue, ...ordered].slice(-50))
      } catch {
        // Retain pending handoffs and retry on the next visible-page poll.
      } finally {
        polling = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), 10_000)
    const onVisibility = () => void poll()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const dismiss = useCallback(() => setPending((queue) => queue.slice(1)), [])
  return { show: pending[0], dismiss }
}
