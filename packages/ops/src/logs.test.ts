import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProject } from './deploy'
import { journalArgs, otherProjectLogs, parseLogsArgs, statusPointer } from './logs'
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
  const answers =
    (out: string, code = 0): Runner =>
    () => ({ code, out, err: '' })
  const request = (target: string) => {
    const req = parseLogsArgs([target, '-n', '5'])
    if (typeof req === 'string') throw new Error(req)
    return req
  }

  it('reads another registered project, on the machine its runtime names', () => {
    const root = resolve(__dirname, '../../..')
    const here = otherProjectLogs(
      request('other'),
      answers(JSON.stringify({ id: 'other', root_path: root })),
    )
    expect(here).toMatchObject({ cmd: 'journalctl' })
    const there = otherProjectLogs(
      request('other'),
      answers(JSON.stringify({ id: 'other', root_path: root, runtime: [{ ssh: 'vm.lan' }] })),
    ) as { cmd: string; args: string[] }
    expect(there.cmd).toBe('ssh')
    expect(there.args.slice(0, 3)).toEqual(['vm.lan', 'journalctl', '--user'])
    expect(there.args).toContain('aico-web.service')
    expect(there.args.slice(-3)).toEqual(['-n', '5', '--no-pager'])
    expect(otherProjectLogs(request('nope'), answers('', 1))).toBeNull()
    expect(
      otherProjectLogs(request('other'), answers(JSON.stringify({ id: 'other', root_path: '/x' }))),
    ).toMatch(/no project.identity.json/)
  })

  it('points at a Status row: its log action, else its project', () => {
    const rows = (row: object) => answers(JSON.stringify({ rows: [row] }))
    const job = {
      id: 'portfolio-ai/portfolio-refresh-property-valuations',
      what: 'Refresh property valuations',
      project: 'portfolio-ai',
    }
    expect(statusPointer('Refresh property valuations', rows(job))).toBe(
      'Refresh property valuations is a job of portfolio-ai: aico logs portfolio-ai',
    )
    expect(statusPointer('portfolio-refresh-property-valuations', rows(job))).toMatch(
      /aico logs portfolio-ai/,
    )
    expect(
      statusPointer(
        'backups-drive',
        rows({
          id: 'jobs/backups-drive',
          what: 'Google Drive backup',
          actions: [{ kind: 'log', ref: 'aico routines log backups-drive' }],
        }),
      ),
    ).toBe('Google Drive backup: aico routines log backups-drive')
    expect(statusPointer('Refresh', rows(job))).toBeNull()
    expect(statusPointer('x', answers('not json'))).toBeNull()
    expect(statusPointer('x', answers('', 1))).toBeNull()
  })

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
