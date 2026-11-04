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
      'err..err',
    ])
    const sys = parseLogsArgs(['redis-server']) as Exclude<ReturnType<typeof parseLogsArgs>, string>
    expect(journalArgs(sys, project, units([], ['redis-server.service']))?.[0]).toBe('-u')
    const all = parseLogsArgs(['aico']) as Exclude<ReturnType<typeof parseLogsArgs>, string>
    expect(journalArgs(all, project, units([]))).toContain('aico-web.service')
  })

  it('-l shows only that level, as st logs -l does', () => {
    const level = (name: string) => {
      const req = parseLogsArgs(['tether@default', '-l', name])
      if (typeof req === 'string') throw new Error(req)
      const args = journalArgs(req, project, units(['tether@default.service'])) ?? []
      return args[args.indexOf('-p') + 1]
    }
    expect(level('WARN')).toBe('warning..warning')
    expect(level('info')).toBe('notice..info')
    expect(level('CRITICAL')).toBe('emerg..crit')
  })

  it('reads retained journals after a transient or removed unit is gone', () => {
    const target = 'aico-deploy-aico-0123456789ab.service'
    const req = parseLogsArgs([target])
    if (typeof req === 'string') throw new Error(req)
    const history =
      (user: boolean): Runner =>
      (cmd, args) => ({
        code: cmd === 'journalctl' ? 0 : 1,
        out:
          cmd === 'journalctl' && args.includes('--user') === user
            ? '{"MESSAGE":"retained deploy output"}\n'
            : '',
        err: '',
      })
    expect(journalArgs(req, project, history(true))?.slice(0, 3)).toEqual(['--user', '-u', target])
    expect(journalArgs(req, project, history(false))?.slice(0, 2)).toEqual(['-u', target])
  })

  it('answers null for a unit neither manager has, and refuses bad options', () => {
    const req = parseLogsArgs(['summitflow']) as Exclude<ReturnType<typeof parseLogsArgs>, string>
    expect(journalArgs(req, project, units([]))).toBeNull()
    expect(parseLogsArgs(['a', 'b'])).toMatch(/one unit/)
    expect(parseLogsArgs(['x', '-l', 'loud'])).toMatch(/level/)
  })
})
