// One door for notices: checks a notice against the contract, logs it, queues
// it for the paired phones when it asks for the phone, wakes the outbox, and
// files its Needs-you ask when it asks the owner something.

import type { PhoneSender } from './fcm'
import type { NeedsYou } from './needs-you'
import { parseNotice } from './notice'
import type { Outbox } from './outbox'
import type { Accepted, NotifyStore, Via } from './store'

export interface NotifierOptions {
  store: NotifyStore
  sender: PhoneSender
  outbox: Outbox
  needsYou: NeedsYou
  now?: () => number
  log?: (line: string) => void
}

export class Notifier {
  constructor(private readonly options: NotifierOptions) {}

  /** Takes a notice (NoticeError when it breaks the contract); the outbox and the ask follow on their own. */
  receive(value: unknown, via: Via): Accepted {
    const { store, sender, outbox, needsYou } = this.options
    const log = this.options.log ?? ((line: string) => console.log(`[notify] ${line}`))
    const notice = parseNotice(value)
    const devices =
      notice.push === 'phone' ? (sender.devices() ?? []).map((device) => device.id) : []
    const accepted = store.accept(notice, via, devices, (this.options.now ?? Date.now)())
    log(
      `${accepted.repeat ? 'repeat of' : 'took'} ${accepted.id} from ${notice.source} via ${via} (${notice.severity}, ${notice.push}${devices.length ? `, ${devices.length} phone(s)` : ''})`,
    )
    if (accepted.repeat) return accepted
    if (devices.length)
      void outbox.kick().catch((error) => log(`outbox pass failed: ${(error as Error).message}`))
    void needsYou
      .noticeAccepted(accepted.id, notice)
      .catch((error) =>
        log(`could not file the ask for ${accepted.id}: ${(error as Error).message}`),
      )
    return accepted
  }
}
