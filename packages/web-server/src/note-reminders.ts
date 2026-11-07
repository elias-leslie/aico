// Reminders on notes. A note carries `remind_at`; when it passes, the owner gets one phone
// notice through the notify path. `POST /api/notes/reminders/run` sends what is due: the
// `note-reminders` job calls it every minute, and the jobs lease means one host runs it at a
// time. Each reminder is marked sent (a synced write) before its notice is queued, so a
// second pass, or the other host once the mark has synced, finds it done.
//
// Notice rules (packages/notify/src/notice.ts): only warnings and criticals go to the phone,
// so a reminder is a warning. Titles are masked like the list previews.

import type { Notifier } from '@aico/notify'
import { maskSecrets } from '@aico/shared/secrets'
import { fromThisMachine } from './guard'
import type { Router } from './http'
import type { NoteRow } from './notes-data'
import type { NotesStore } from './notes-db'
import { HttpError } from './tether'

const TITLE_MAX = 120
/** A reminder this much later than its time says how late it is. */
const LATE_MS = 5 * 60_000

export interface ReminderDeps {
  store: NotesStore
  notifier: Pick<Notifier, 'receive'>
  publicHost: string | null
  now?: () => number
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** "3 hours ago", "2 days ago": no clock time, since the two hosts do not share a time zone. */
export function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${plural(hours, 'hour')} ago`
  return `${plural(Math.round(hours / 24), 'day')} ago`
}

/** What the notice calls the note: its title, else the first line of its text. */
function nameOf(note: NoteRow): string {
  const title = note.title.trim() || note.body.trim().split('\n', 1)[0]?.trim() || ''
  const clean = maskSecrets(title).replace(/\s+/g, ' ')
  if (!clean) return 'Untitled note'
  return [...clean].length > TITLE_MAX ? `${[...clean].slice(0, TITLE_MAX - 1).join('')}…` : clean
}

function noticeFor(note: NoteRow, sentAt: number, publicHost: string | null) {
  const remindAt = note.remind_at as number
  const late = sentAt - remindAt
  return {
    v: 1,
    source: 'aico',
    kind: 'info',
    severity: 'warning',
    push: 'phone',
    key: `reminder:${note.id}:${remindAt}`,
    title: `Reminder: ${nameOf(note)}`,
    body: late > LATE_MS ? `This was due ${ago(late)}.` : 'It is due now.',
    cooldown: 86_400,
    ...(publicHost
      ? {
          open: `https://${publicHost}/notes?id=${note.id}`,
          actions: ['open', 'mark-read'],
          primary: 'open',
        }
      : {}),
  }
}

/** Sends every reminder that is due and not yet sent; returns how many went out. */
export function sendDueReminders(deps: ReminderDeps): { sent: number; failed: number } {
  const now = (deps.now ?? Date.now)()
  const notes = deps.store.notes
  let sent = 0
  let failed = 0
  for (const due of deps.store.notes.dueReminders(now)) {
    const claimed = notes.claimReminder(due.id, now)
    if (!claimed) continue
    try {
      deps.notifier.receive(noticeFor(claimed, now, deps.publicHost), 'local')
      sent += 1
    } catch (error) {
      deps.store.notes.releaseReminder(claimed.id, claimed.remind_at as number)
      failed += 1
      console.error(`[aico-web] reminder for note ${claimed.id} not queued:`, error)
    }
  }
  return { sent, failed }
}

export function registerReminderRoutes(router: Router, deps: ReminderDeps): void {
  router.on('POST', '/api/notes/reminders/run', (ctx) => {
    // Only the job on this machine runs it; a page or the other host cannot.
    if (!fromThisMachine(ctx.req)) throw new HttpError(403, 'Send reminders from the Aico host.')
    const { sent, failed } = sendDueReminders(deps)
    if (failed > 0)
      return {
        state: 'failed',
        message: `${plural(failed, 'reminder')} could not be queued.`,
        sent,
      }
    return {
      state: 'ok',
      message: sent ? `Sent ${plural(sent, 'reminder')}.` : 'No reminders due.',
      sent,
    }
  })
}
