import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { type Ask, askNotice } from './asks'
import { type Notice, PUSH_ARGV, pushRoute, resolveNotice, sendNotice } from './notice'
import { type Share, showNotice } from './shows'

const hasNightshift = (() => {
  try {
    execFileSync('nightshift', ['push', '--schema'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

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
  it.skipIf(!hasNightshift).each(notices)('Nightshift accepts the %s notice', (_name, notice) => {
    const out = execFileSync('nightshift', [...PUSH_ARGV.slice(1), '--dry-run'], {
      input: JSON.stringify(notice),
    })
    expect(String(out).length).toBeGreaterThan(0)
  })

  it('sends through the ssh alias when AICO_PUSH_SSH is set, and cannot resolve there', async () => {
    expect(pushRoute({})).toEqual({ argv: PUSH_ARGV, canResolve: true })
    vi.stubEnv('AICO_PUSH_SSH', 'pve-alerts')
    try {
      const runs: { argv: string[]; input?: string }[] = []
      const run = async (argv: string[], _t: number, input?: string) => {
        runs.push({ argv, input })
        return ''
      }
      await sendNotice(run, notices[1][1])
      await resolveNotice(run, 'ask:x', 'done')
      expect(runs).toHaveLength(1)
      expect(runs[0]?.argv).toEqual([
        'ssh',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        'pve-alerts',
      ])
      expect(JSON.parse(runs[0]?.input ?? '{}')).toMatchObject({ v: 1, key: 'ask:abcdefabcdef' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('logs a refusal loudly and does not throw', async () => {
    const error = Object.assign(new Error('refused'), { code: 2 })
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => logged.push(args.join(' '))
    try {
      await sendNotice(async () => Promise.reject(error), notices[0][1])
      await resolveNotice(async () => Promise.reject(error), 'ask:x', 'done')
    } finally {
      console.error = original
    }
    expect(logged.join('\n')).toContain('contract refusal')
  })
})
