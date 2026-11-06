import { NoticeError, parseNotice } from '@aico/notify'
import { describe, expect, it } from 'vitest'
import { type Ask, askNotice } from './asks'
import { type Notice, resolveNotice, sendNotice } from './notice'
import { type Share, showNotice } from './shows'

const ASK = {
  id: 'abcdefabcdef',
  session: null,
  requester: 'nightly',
  question: 'Merge now?',
  blocking: true,
  state: 'open',
} as unknown as Ask

const SHARE = {
  id: '0123456789ab',
  kind: 'files',
  title: 'Report',
  paths: ['/srv/scratch/report.md'],
} as unknown as Share

const notices: [string, Notice][] = [
  ['ask with the public host', askNotice(ASK, 'nightly', 'aico.summitflow.dev')],
  ['ask without it', askNotice(ASK, null, null)],
  ['share', showNotice(SHARE, 'aico.summitflow.dev')],
  ['share without the public host', showNotice(SHARE, null)],
]

describe('notice contract v1', () => {
  it.each(notices)('the contract accepts the %s notice', (_name, notice) => {
    expect(parseNotice(notice)).toMatchObject({ source: 'aico', key: notice.key })
  })

  it('hands the notice to the Notifier and ends it by source and key', async () => {
    const received: unknown[][] = []
    const resolved: unknown[][] = []
    const sink = {
      receive: (...args: unknown[]) => received.push(args),
      resolve: async (...args: unknown[]) => resolved.push(args),
    }
    await sendNotice(sink, notices[1][1])
    await resolveNotice(sink, 'ask:x', 'done')
    expect(received).toEqual([[notices[1][1], 'local']])
    expect(resolved).toEqual([['aico', 'ask:x', 'done']])
  })

  it('logs a refusal loudly and does not throw', async () => {
    const refuse = () => {
      throw new NoticeError('title', 'too long')
    }
    const sink = { receive: refuse, resolve: async () => refuse() }
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => logged.push(args.join(' '))
    try {
      await sendNotice(sink, notices[0][1])
      await resolveNotice(sink, 'ask:x', 'done')
    } finally {
      console.error = original
    }
    expect(logged.join('\n')).toContain('contract refusal')
  })
})
