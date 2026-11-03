// `tether ask` flags and output for asks that want files.

import { describe, expect, it } from 'vitest'
import { askCreateBody, formatAsk } from './ask-cli'

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
