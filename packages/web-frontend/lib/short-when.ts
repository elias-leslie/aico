// One short date form across the app's pages.

/** "Nov 6, 8:30 PM", the same short form across the app's pages. */
export function shortWhen(time: string | null | undefined): string {
  if (!time) return 'Not recorded'
  const at = new Date(time)
  if (Number.isNaN(at.getTime())) return 'Not recorded'
  return at.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
