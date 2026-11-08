// The owner's Settings > Notifications choices, applied at the door: they beat every default and
// every sender. Off stops the phone push or the desktop card and nothing else: the notice still
// lands in the tray, Needs you and the digest. On reaches the phone or the desktop even when the
// sender did not ask for it; an `ok` still never does, since a recovery only ends an earlier notice.
// Read live on every notice, so a switch applies at once. No choice saved: what the row shows, so a
// row the table keeps off is off, and otherwise the sender's route under the rule (phone.ts).

import type { Notice } from './notice'
import { popsUp } from './phone'
import { describeType, NOTICE_TYPES, typeOf } from './types'

export const CHANNELS = ['phone', 'desktop'] as const
export type NoticeChannel = (typeof CHANNELS)[number]

/** What the owner chose for a type on a channel; null: no choice, the rule decides. */
export interface NoticeChoices {
  choice(type: string, channel: NoticeChannel): boolean | null
}

export const NO_CHOICES: NoticeChoices = { choice: () => null }

const FORCED_REASON = 'You turned this type on in Settings.'
const SILENCED_REASON = 'This type is off for the phone in Settings.'
const CAPPED_REASON = 'It already reached your phone today.'

/** A choice that could not be read decides nothing: losing a notice is worse than one extra push. */
function read(choices: NoticeChoices, type: string, channel: NoticeChannel): boolean | null {
  try {
    return choices.choice(type, channel)
  } catch (error) {
    console.error(`[notify] could not read the ${channel} choice for ${type}:`, error)
    return null
  }
}

/** On or off when a row says so; null: the rule's route stands. A row the table keeps off is off. */
function decide(choices: NoticeChoices, type: string, channel: NoticeChannel): boolean | null {
  const chosen = read(choices, type, channel)
  if (chosen !== null) return chosen
  return NOTICE_TYPES.find((row) => row.id === type)?.[channel] === false ? false : null
}

/** On may also reach the owner when the sender did not ask: not for a row only the rule routes. */
const mayForce = (notice: Notice) =>
  notice.severity !== 'ok' && !describeType(typeOf(notice)).ruleOnly

/** The notice as it stands once it stays off the phone. */
export function keptOffPhone(notice: Notice, why = SILENCED_REASON): Notice {
  const { phone_reason: _dropped, ...rest } = notice
  return { ...rest, push: 'tray', phone_silenced: why }
}

/** The notice with the owner's phone choice applied; the rule's route stays when there is none. */
export function applyPhoneChoice(notice: Notice, choices: NoticeChoices): Notice {
  const choice = decide(choices, typeOf(notice), 'phone')
  if (choice === false && notice.push === 'phone') return keptOffPhone(notice)
  if (choice === true && notice.push === 'tray' && mayForce(notice))
    return { ...notice, push: 'phone', phone_reason: FORCED_REASON }
  return notice
}

/** The notice held to its type's daily phone limit; `pushedToday` counts this type's pushes so far. */
export function applyDailyLimit(notice: Notice, pushedToday: () => number): Notice {
  const limit = describeType(typeOf(notice)).phonePerDay
  if (limit === undefined || notice.push !== 'phone' || pushedToday() < limit) return notice
  return keptOffPhone(notice, CAPPED_REASON)
}

/** A push on its way or delivered, so it counts: one that was dropped or failed did not. */
export function headedToPhone({
  notice,
  deliveries,
}: {
  notice: Notice
  deliveries: readonly { state: string }[]
}): boolean {
  return notice.push === 'phone' && deliveries.some(({ state }) => state !== 'failed')
}

/** Whether the phone choice says to stop a push already queued. */
export function phoneSilenced(notice: Notice, choices: NoticeChoices): boolean {
  return decide(choices, typeOf(notice), 'phone') === false
}

/** Whether a notice shows a desktop card: the rule (popsUp), unless the owner chose. */
export function desktopCard(notice: Notice, choices: NoticeChoices): boolean {
  const choice = decide(choices, typeOf(notice), 'desktop')
  if (choice === false) return false
  return popsUp(notice) || (choice === true && mayForce(notice))
}

/** Whether a type's desktop cards are off (asks and approval cards, which are not notices). */
export function desktopOff(type: string, choices: NoticeChoices): boolean {
  return decide(choices, type, 'desktop') === false
}
