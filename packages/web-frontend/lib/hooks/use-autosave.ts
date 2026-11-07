'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

interface Fields {
  [field: string]: string
}

/** The fields of `draft` that differ from `base`, or null when none do. */
function changes<T extends Fields>(draft: T, base: T): Partial<T> | null {
  const found: Fields = {}
  for (const key of Object.keys(draft)) {
    if (draft[key] !== base[key]) found[key] = draft[key]
  }
  return Object.keys(found).length > 0 ? (found as Partial<T>) : null
}

/**
 * The text being edited, saved a moment after the owner stops typing. `base`
 * is what the server holds now; only the fields that changed are sent. A
 * failed save stays visible (`error`) until `retry` or the next edit saves it.
 * An untouched draft follows `base` when the server's copy moves on. Leaving
 * the screen or hiding the app sends what is pending.
 */
export function useAutosave<T extends Fields>({
  base,
  save,
  delay = 800,
}: {
  base: T
  save: (patch: Partial<T>) => Promise<unknown>
  delay?: number
}) {
  const [draft, setDraft] = useState<T>(base)
  const [state, setState] = useState<SaveState>('saved')
  const confirmed = useRef(base)
  const latest = useRef(draft)
  latest.current = draft
  const saveRef = useRef(save)
  saveRef.current = save
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busy = useRef(false)

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])

  const run = useCallback(async () => {
    clear()
    if (busy.current) return
    const patch = changes(latest.current, confirmed.current)
    if (!patch) {
      setState('saved')
      return
    }
    busy.current = true
    setState('saving')
    try {
      await saveRef.current(patch)
    } catch {
      busy.current = false
      setState('error')
      return
    }
    busy.current = false
    confirmed.current = { ...confirmed.current, ...patch }
    if (changes(latest.current, confirmed.current)) {
      setState('dirty')
      timer.current = setTimeout(() => void run(), delay)
    } else setState('saved')
  }, [delay, clear])

  const baseKey = JSON.stringify(base)
  // biome-ignore lint/correctness/useExhaustiveDependencies: baseKey stands for base
  useEffect(() => {
    if (busy.current || changes(latest.current, confirmed.current)) return
    const before = confirmed.current
    confirmed.current = base
    // Typing that lands in the same moment wins over the server's copy.
    setDraft((now) => (changes(now, before) ? now : base))
  }, [baseKey])

  const draftKey = JSON.stringify(draft)
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftKey stands for draft
  useEffect(() => {
    if (busy.current) return
    if (!changes(draft, confirmed.current)) {
      setState((now) => (now === 'error' ? now : 'saved'))
      return
    }
    setState((now) => (now === 'error' ? now : 'dirty'))
    clear()
    timer.current = setTimeout(() => void run(), delay)
    return clear
  }, [draftKey, delay, run, clear])

  // Leaving the screen or the app sends what is pending.
  useEffect(() => {
    const flush = () => {
      if (changes(latest.current, confirmed.current)) void run()
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [run])

  return {
    draft,
    edit: (change: Partial<T>) => setDraft((now) => ({ ...now, ...change })),
    state,
    retry: () => void run(),
  }
}
