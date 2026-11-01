'use client'

import { useEffect, useState } from 'react'

/** Now in ms, again every `everyMs`: ages shown from a time stay true while nothing else changes. */
export function useClock(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
