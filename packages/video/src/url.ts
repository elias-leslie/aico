export class UsageError extends Error {}

const ID = /^[A-Za-z0-9_-]{11}$/

/** The 11-character video id from a watch, youtu.be, shorts, live or embed link, or a bare id. */
export function videoId(input: string): string | null {
  const text = input.trim()
  if (ID.test(text)) return text
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '')
  let candidate: string | null = null
  if (host === 'youtu.be') candidate = url.pathname.split('/')[1] ?? null
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const [, kind, id] = url.pathname.split('/')
    if (url.pathname === '/watch') candidate = url.searchParams.get('v')
    else if (['shorts', 'live', 'embed', 'v'].includes(kind)) candidate = id ?? null
  }
  return candidate && ID.test(candidate) ? candidate : null
}

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`

/** Seconds from `90`, `1:30` or `1:02:03`. */
function seconds(text: string): number {
  const parts = text.trim().split(':')
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p)))
    throw new UsageError(`"${text}" is not a time (use mm:ss, h:mm:ss or seconds)`)
  return parts.reduce((total, p) => total * 60 + Number(p), 0)
}

export interface Range {
  start: number
  end: number | null
}
/** `2:00-4:00`, `2:00-` (to the end) or `-4:00` (from the start). */
export function parseRange(text: string): Range {
  const [from, to, ...extra] = text.split('-')
  if (to === undefined || extra.length)
    throw new UsageError(`--range needs START-END, like 2:00-4:00`)
  const range = { start: from.trim() ? seconds(from) : 0, end: to.trim() ? seconds(to) : null }
  if (range.end !== null && range.end <= range.start)
    throw new UsageError(`--range ${text}: the end is not after the start`)
  return range
}

export function clock(total: number, long = false): string {
  const t = Math.max(0, Math.floor(total))
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    s = t % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h || long ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}
