/** `340 B`, `2.4 KB`, `12 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
}

/** `Nov 2, 3:41 PM`, with the year once it isn't this one. */
export function formatWhen(ms: number, now = Date.now()): string {
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  })
}

const STATUS_WORD: Record<string, string> = {
  new: 'Saved',
  extracting: 'Reading…',
  ready: 'Read',
  failed: "Couldn't read it",
  filed: 'Filed',
}

/** `1:42 PM`. */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** The first line of some text, cut to fit a list row. */
export function firstLine(text: string | null, max = 80): string {
  const line = (text ?? '').split('\n').find((part) => part.trim()) ?? ''
  const trimmed = line.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** The capture's state in words. `new` is just saved: nothing has read it yet. */
export function statusWord(status: string): string {
  return STATUS_WORD[status] ?? status
}
