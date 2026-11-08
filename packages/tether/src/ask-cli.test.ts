// `tether ask` flags and output for asks that want files.

import type { TetherPaths } from '@aico/session-engine/paths'
import { describe, expect, it } from 'vitest'
import { ASK_USAGE, askCreateBody, formatAsk, runAsk } from './ask-cli'

const env = { AICO_WIDGET_ID: 'aico-widget-0123abcd' }
const create = (...args: string[]) => askCreateBody(['Q?', ...args], env, '/x')

describe('tether ask create --files', () => {
  it('takes N, MIN-MAX and a hint', () => {
    expect(create('--files', '1', '--files-hint', 'odometer, engine off')).toMatchObject({
      files: { min: 1, max: 1, hint: 'odometer, engine off' },
    })
    expect(create('--files=1-5')).toMatchObject({ files: { min: 1, max: 5 } })
    expect(create('--files', '0-3')).toMatchObject({ files: { min: 0, max: 3 } })
    expect(create('--files', '20')).toMatchObject({ files: { min: 20, max: 20 } })
    expect(create('--files', '2')).not.toHaveProperty('files.hint')
    expect(create()).not.toHaveProperty('files')
  })

  it('takes the --photos and --photo-hint aliases', () => {
    expect(create('--photos', '2-4', '--photo-hint', 'both sides')).toMatchObject({
      files: { min: 2, max: 4, hint: 'both sides' },
    })
  })

  it('says what is wrong with a range or a hint', () => {
    for (const range of ['0', '21', '3-2', 'x', '1-', '-3', '1-2-3', ''])
      expect(create('--files', range), range).toMatch(/--files takes N or MIN-MAX/)
    expect(create('--files-hint', 'front')).toMatch(/needs --files/)
    expect(create('--files', '1', '--files-hint', 'x'.repeat(101))).toMatch(/at most 100/)
    expect(create('--files', '1', '--files-hint', ' ')).toMatch(/at most 100/)
  })
})

describe('tether ask create --file', () => {
  it('sends each file as an absolute path to attach', () => {
    expect(create('--file', 'plan.md', '--file=/srv/a/shot.png')).toMatchObject({
      attach: ['/x/plan.md', '/srv/a/shot.png'],
    })
    expect(create()).not.toHaveProperty('attach')
  })

  it('refuses --file with --share, and more than 20', () => {
    expect(create('--file', 'a', '--share', '0123456789ab')).toMatch(/not both/)
    const many = Array.from({ length: 21 }, (_, i) => ['--file', `f${i}`]).flat()
    expect(create(...many)).toMatch(/at most 20/)
  })

  it('lists attached files in tether ask get, a missing one as moved', () => {
    const text = formatAsk({
      id: 'abcdefabcdef',
      session: '0123abcd',
      requester: null,
      question: 'Ship it?',
      options: [],
      recommended: null,
      body: null,
      command: null,
      share: '0123456789ab',
      attached: [
        { path: '/srv/a/plan.md', name: 'plan.md', kind: 'file', size: 2048 },
        { path: '/srv/a/gone.png', name: 'gone.png', kind: 'missing', size: null },
      ],
      blocking: false,
      state: 'open',
      answer: null,
      note: null,
      delivery: null,
    })
    expect(text).toContain('attached: /srv/a/plan.md  2.0 KB')
    expect(text).toContain('attached: /srv/a/gone.png  (moved or deleted)')
  })
})

describe('formatAsk with files', () => {
  const base = {
    id: 'abcdefabcdef',
    session: '0123abcd',
    requester: null,
    question: 'Odometer?',
    options: [],
    recommended: null,
    body: null,
    command: null,
    share: null,
    blocking: false,
    state: 'open',
    answer: null,
    note: null,
    delivery: null,
  }

  it('shows what it wants', () => {
    expect(
      formatAsk({ ...base, wantsFiles: { min: 1, max: 5, hint: 'service invoices' } }),
    ).toContain('  wants files: 1-5 (service invoices)')
    expect(formatAsk({ ...base, wantsFiles: { min: 2, max: 2, hint: null } })).toContain(
      '  wants files: 2',
    )
  })

  it('shows one line per file once answered', () => {
    const text = formatAsk({
      ...base,
      state: 'answered',
      wantsFiles: { min: 1, max: 3, hint: null },
      files: [
        {
          id: 'aaaaaaaaaaaa',
          name: 'odometer.jpg',
          mime: 'image/jpeg',
          size: 2048,
          path: '/data/blobs/aa/x',
          host: 'davion-sidarli',
        },
        {
          id: 'bbbbbbbbbbbb',
          name: 'a.pdf',
          mime: 'application/pdf',
          size: 12,
          path: null,
          host: null,
        },
      ],
    })
    expect(text).toContain(
      '  file aaaaaaaaaaaa  odometer.jpg  image/jpeg  2.0 KB  /data/blobs/aa/x  host davion-sidarli',
    )
    expect(text).toContain('  file bbbbbbbbbbbb  a.pdf  application/pdf  12 B  (no path)')
    expect(text).toContain('when handled: tether ask done abcdefabcdef')
  })
})

describe('tether ask <sub> --help', () => {
  it('prints the usage and exits 0 instead of an unknown-option error', async () => {
    for (const args of [
      ['create', '--help'],
      ['list', '-h'],
      ['get', '--help'],
    ]) {
      const out: string[] = []
      const err: string[] = []
      const paths = { socket: '/nonexistent/tether.sock', instance: 'test' } as TetherPaths
      const code = await runAsk(
        { out: (text) => out.push(text), err: (text) => err.push(text) },
        paths,
        false,
        args,
        {},
        '/tmp',
      )
      expect(code).toBe(0)
      expect(err).toEqual([])
      expect(out.join('')).toBe(ASK_USAGE)
    }
  })
})

describe('tether ask with a wrong command', () => {
  it('names the mistake in one line instead of printing the whole usage', async () => {
    const paths = { socket: '/nonexistent/tether.sock', instance: 'test' } as TetherPaths
    const err = async (...args: string[]) => {
      const lines: string[] = []
      const code = await runAsk(
        { out: () => {}, err: (text) => lines.push(text) },
        paths,
        false,
        args,
        {},
        '/tmp',
      )
      return { code, text: lines.join('\n') }
    }
    expect(await err('show', 'abc')).toEqual({
      code: 2,
      text: 'tether ask: unknown command show; tether ask --help shows how',
    })
    expect((await err('gte', 'abc')).text).toContain('(did you mean get?)')
    expect((await err('get')).text).toBe(
      'tether ask get takes one ask id; tether ask --help shows how',
    )
    expect((await err()).text).toBe(ASK_USAGE)
  })
})
