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
