import type { ReactNode } from 'react'

/** The text with each place `query` appears marked (case-blind, as the search is). */
export function Marked({ text, query }: { text: string; query: string }) {
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  if (!needle) return <>{text}</>
  const parts: ReactNode[] = []
  let from = 0
  for (
    let at = lower.indexOf(needle);
    at >= 0;
    at = lower.indexOf(needle, from)
  ) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}
