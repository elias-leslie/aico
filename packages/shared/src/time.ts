// Times a person reads in a terminal: this machine's local time with its zone, written one
// way everywhere ("Nov 6, 10:30 PM EST"), so a reset beside a collection time cannot be off by hours.
// Formatters are made per call so a changed TZ is honored.

/** "Nov 6, 10:30 PM EST" in the local zone. */
export function localTime(at: Date | number | string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(at))
}

/** "10:30 PM EST" in the local zone. */
export function localClock(at: Date | number | string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(at))
}

// How long ago, said one way everywhere (owner-facing pages, notices and CLIs): minutes under an
// hour, hours rounded to the nearest under two days (90 min reads "2 h ago"), then whole days.

const MINUTE = 60_000
const DAY_MINUTES = 1440

/** Whole minutes from `at` to `now`, rounded; never negative. */
const minutesAgo = (at: number, now: number) => Math.max(0, Math.round((now - at) / MINUTE))

/** "just now", "48 min ago", "2 h ago", "3 days ago". */
export function ago(at: number, now: number): string {
  const short = shortAgo(at, now)
  if (short === 'now') return 'just now'
  const minutes = minutesAgo(at, now)
  return minutes < 2 * DAY_MINUTES
    ? `${short} ago`
    : `${Math.floor(minutes / DAY_MINUTES)} days ago`
}

/** The short form for tight lists: "now", "48 min", "2 h", "3 d". */
export function shortAgo(at: number, now: number): string {
  const minutes = minutesAgo(at, now)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 2 * DAY_MINUTES) return `${Math.round(minutes / 60)} h`
  return `${Math.floor(minutes / DAY_MINUTES)} d`
}

/** `ago` for the past two days, then the day ("Nov 5"; "Feb 3, 2025" in another year). */
export function agoOrDate(at: number, now: number): string {
  if (minutesAgo(at, now) < 2 * DAY_MINUTES) return ago(at, now)
  const day = new Date(at)
  return day.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  })
}
