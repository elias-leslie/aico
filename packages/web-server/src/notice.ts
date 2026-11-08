// The owner notices Aico sends itself (notice contract v1, contracts/notice.schema.json): one
// small builder per notice, handed to this process's own Notifier (packages/notify), which logs it,
// queues the phone push through the host's sender (FCM, or the Proxmox relay on a host without
// its own) and files the Needs you ask. Failures are logged and never reach the caller; a
// contract refusal is a bug in the builder and is logged loudly.

import { NoticeError } from '@aico/notify'

export type NoticeAction = 'answer' | 'done' | 'open'

/** The part of notice v1 Aico uses. */
export interface Notice {
  v: 1
  source: 'aico'
  kind: 'question' | 'todo' | 'info'
  severity: 'info' | 'warning'
  title: string
  body: string
  key: string
  open?: string
  actions?: NoticeAction[]
  primary?: NoticeAction
  push: 'phone' | 'tray'
  /** Why the phone is interrupted (packages/notify phone.ts); without it the notice stays in the tray. */
  interrupt?: 'needs-you'
}

/** What notices need of the Notifier. */
export interface NoticeSink {
  receive(notice: unknown, via: 'local'): unknown
  resolve(source: string, key: string, text: string): Promise<unknown>
}

/** Sends the notice; logs a failure, loudly for a contract refusal, and never throws. */
export async function sendNotice(sink: NoticeSink, notice: Notice): Promise<void> {
  try {
    sink.receive(notice, 'local')
  } catch (error) {
    const refused = error instanceof NoticeError ? ' (contract refusal, a bug)' : ''
    console.error(
      `[aico-web] notice failed key=${notice.key}${refused}: ${(error as Error).message}`,
    )
  }
}

/** Ends the notice behind `key`: its Needs you ask is withdrawn and an `ok` follows. */
export async function resolveNotice(sink: NoticeSink, key: string, text: string): Promise<void> {
  try {
    await sink.resolve('aico', key, text)
  } catch (error) {
    console.warn(`[aico-web] notice resolve failed key=${key}: ${(error as Error).message}`)
  }
}
