/** A reminder time in the form `<input type="datetime-local">` takes and gives. */

const pad = (n: number) => String(n).padStart(2, '0')

/** `2026-11-07T14:30` in the viewer's own time zone. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The time (ms) a complete `datetime-local` value means in the viewer's time zone; null if it is empty or not a time. */
export function fromLocalInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}
