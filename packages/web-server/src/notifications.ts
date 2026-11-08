// Settings > Notifications: one row per notification type (packages/notify types.ts), each with a
// phone and a desktop switch and what fired in the last week.
//
//   GET  /api/notifications                  {types: [...], fixed: [...]}
//   GET  /api/notifications/recent?type=ID   the type's recent notices, with why each went out
//   PUT  /api/notifications/choice           {type, channel, on}: saved at once, read by the door
//   GET  /api/notifications/phone-off        loopback: the types Proxmox's sender keeps off the phone
//
// Every switch the owner flips is saved as flipped, and beats the rule from then on.

import {
  CHANNELS,
  describeType,
  headedToPhone,
  NOTICE_TYPES,
  type NoticeChannel,
  type NotifyStore,
  popsUp,
  type StoredNotice,
  typeOf,
  validTypeId,
} from '@aico/notify'
import { fromThisMachine } from './guard'
import { objectBody, type Router } from './http'
import { HttpError } from './tether'

const WEEK_MS = 7 * 86_400_000
const RECENT_MAX = 20

/**
 * What reaches the owner without passing a door that can read a switch: built into the phone app,
 * so a switch needs a new app release (native/android alarm/OutageAlarm.kt, update/Updater.kt,
 * push/NsMessagingService.kt). Shown as what they are, never hidden.
 */
const FIXED_ROWS = [
  {
    id: 'phone-home-alarm',
    label: 'Home unreachable alarm',
    hint: "The phone raises this itself when it can't reach home, so nothing here can reach it then. A switch needs an app update.",
  },
  {
    id: 'phone-update',
    label: 'App update ready',
    hint: 'The phone app says this itself when a new version is downloaded. A switch needs an app update.',
  },
  {
    id: 'phone-pairing',
    label: 'Phone pairing problem',
    hint: "The phone app says this itself when it can't read an alert. A switch needs an app update.",
  },
] as const

export interface ChoiceStore {
  noticeChoices(): Map<string, { phone: boolean | null; desktop: boolean | null }>
  setNoticeChoice(type: string, channel: NoticeChannel, value: boolean): void
}

export interface NotificationDeps {
  notify: Pick<NotifyStore, 'since'>
  choices: ChoiceStore
  now?: () => number
}

/** A notice that fired: an `ok` only ends an earlier one. */
const fired = ({ notice }: StoredNotice) => notice.severity !== 'ok'

/** What the rule does for a type: the table's word, or for a sender it doesn't name, its notices'. */
function ruleDefault(id: string, week: readonly StoredNotice[], channel: NoticeChannel): boolean {
  if (NOTICE_TYPES.some((type) => type.id === id)) return describeType(id)[channel]
  return week.some(({ notice }) =>
    channel === 'phone'
      ? notice.push === 'phone' || notice.phone_silenced !== undefined
      : popsUp(notice),
  )
}

function typeRows(deps: NotificationDeps, now: number) {
  const byType = new Map<string, StoredNotice[]>()
  for (const stored of deps.notify.since(now - WEEK_MS)) {
    const id = typeOf(stored.notice)
    byType.set(id, [...(byType.get(id) ?? []), stored])
  }
  const saved = deps.choices.noticeChoices()
  const named = NOTICE_TYPES.map((type) => type.id)
  const senders = [...new Set([...byType.keys(), ...saved.keys()])]
    .filter((id) => !named.includes(id))
    .sort()
  return [...named, ...senders].map((id) => {
    const type = describeType(id)
    const week = byType.get(id) ?? []
    const switchFor = (channel: NoticeChannel) => {
      const chosen = saved.get(id)?.[channel] ?? null
      return { on: chosen ?? ruleDefault(id, week, channel), chosen: chosen !== null }
    }
    const firing = week.filter(fired)
    return {
      id,
      label: type.label,
      hint: type.hint,
      phone: switchFor('phone'),
      desktop: switchFor('desktop'),
      fired: firing.length,
      phoned: firing.filter(headedToPhone).length,
    }
  })
}

function phoneWord(stored: StoredNotice): string {
  const { notice, deliveries } = stored
  if (notice.phone_silenced) return 'silenced'
  if (notice.push !== 'phone') return 'none'
  if (deliveries.some((delivery) => delivery.state === 'sent')) return 'sent'
  if (deliveries.some(({ state }) => state === 'pending' || state === 'sending')) return 'queued'
  if (deliveries.some((delivery) => delivery.state === 'unsure')) return 'unsure'
  return deliveries.length ? 'failed' : 'none'
}

/** Why a notice went where it went, in words that match what happened to it. */
function whyWords(stored: StoredNotice): string {
  const { phone_reason, phone_silenced } = stored.notice
  if (phone_reason) return phone_reason
  if (phone_silenced) return phone_silenced
  return ['sent', 'queued', 'unsure'].includes(phoneWord(stored))
    ? 'Sent before Aico kept a reason for each push.'
    : 'Stays in the tray: nothing about it needed you right away.'
}

export function registerNotificationRoutes(router: Router, deps: NotificationDeps): void {
  const now = () => (deps.now ?? Date.now)()
  const list = () => ({ types: typeRows(deps, now()), fixed: FIXED_ROWS })

  router.on('GET', '/api/notifications', () => list())

  router.on('GET', '/api/notifications/recent', (ctx) => {
    const type = ctx.query.get('type') ?? ''
    if (!validTypeId(type)) throw new HttpError(422, 'type: not a notification type')
    const matching = deps.notify
      .since(now() - WEEK_MS)
      .filter((stored) => fired(stored) && typeOf(stored.notice) === type)
    const items = matching.slice(0, RECENT_MAX).map((stored) => ({
      id: stored.id,
      at: stored.receivedAt,
      title: stored.notice.title,
      phone: phoneWord(stored),
      desktop: stored.notice.desktop_card ?? popsUp(stored.notice),
      why: whyWords(stored),
      machine: stored.notice.machine ?? null,
      project: stored.notice.project ?? null,
      raised_by: stored.notice.raised_by ?? null,
    }))
    return { items, total: matching.length }
  })

  router.on('PUT', '/api/notifications/choice', async (ctx) => {
    const body = objectBody(await ctx.body())
    const { type, channel, on } = body
    if (typeof type !== 'string' || !validTypeId(type))
      throw new HttpError(422, 'type: not a notification type')
    if (!(CHANNELS as readonly unknown[]).includes(channel))
      throw new HttpError(422, 'channel: phone or desktop')
    if (typeof on !== 'boolean') throw new HttpError(422, 'on: true or false')
    deps.choices.setNoticeChoice(type, channel as NoticeChannel, on)
    return list()
  })

  router.on('GET', '/api/notifications/phone-off', (ctx) => {
    if (!fromThisMachine(ctx.req))
      throw new HttpError(403, 'Read only from this machine (loopback)')
    return {
      phone_off: typeRows(deps, now())
        .filter((row) => !row.phone.on)
        .map((row) => row.id),
    }
  })
}
