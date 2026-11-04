import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProject } from './deploy'
import { journalArgs, parseLogsArgs } from './logs'
import type { Runner } from './sh'

const project = loadProject(resolve(__dirname, '../../..'))
const units =
  (user: string[], system: string[] = []): Runner =>
  (_cmd, args) => ({
    code: (args[0] === '--user' ? user : system).includes(args.at(-1) as string) ? 0 : 1,
    out: '',
    err: '',
  })

describe('aico logs', () => {
  it('reads a user unit, a system unit, or every unit of the project', () => {
    const req = parseLogsArgs(['tether@default', '-n', '5', '--since', '2h', '-l', 'error'])
    if (typeof req === 'string') throw new Error(req)
    expect(journalArgs(req, project, units(['tether@default.service']))).toEqual([
      '--user',
      '-u',
      'tether@default.service',
      '-n',
      '5',
      '--no-pager',
      '--since',
      '-2h',
      '-p',
      'err',
    ])
    const sys = parseLogsArgs(['redis-server']) as Exclude<ReturnType<typeof parseLogsArgs>, string>
    expect(journalArgs(sys, project, units([], ['redis-server.service']))?.[0]).toBe('-u')
    const all = parseLogsArgs(['aico']) as Exclude<ReturnType<typeof parseLogsArgs>, string>
    expect(journalArgs(all, project, units([]))).toContain('aico-web.service')
  })

  it('answers null for a unit neither manager has, and refuses bad options', () => {
    const req = parseLogsArgs(['summitflow']) as Exclude<ReturnType<typeof parseLogsArgs>, string>
    expect(journalArgs(req, project, units([]))).toBeNull()
    expect(parseLogsArgs(['a', 'b'])).toMatch(/one unit/)
    expect(parseLogsArgs(['x', '-l', 'loud'])).toMatch(/level/)
  })
})
