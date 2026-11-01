import { describe, expect, it, vi } from 'vitest'
import { readNightshiftView } from './nightshift'

const URL = 'http://127.0.0.1:3020'
const BOARD = {
  snapshot: { state: 'fresh', age: 60 },
  generated_at: '2026-10-31T10:00:00+00:00',
  verdict: { state: 'warn', label: 'Needs a look', reason: '', doing: '' },
  tiles: [
    {
      id: 'disk',
      label: 'Disk',
      state: 'warn',
      summary: '91% used',
      age: 30,
      checked: 5,
      link: 'l',
    },
  ],
  hosts: [{ id: 'ws', state: 'warn' }],
  needs_you: 1,
  links: { status: 's', needs_you: 'n', notices: 'x' },
}
const finding = (id: string, age: number) => ({ id, state: 'warn', age, checked: 5, calls: 0 })
const approval = (id: string, left: number) => ({
  id,
  title: `Approve ${id}`,
  open: `https://a/e/${id}`,
  left,
})

// GET /api/items?list=all, as Nightshift's items/present.py items_json() answers; words computed 10 s before `at`.
const ITEMS = {
  v: 1,
  list: 'all',
  at: 1_000_010,
  rev: 7,
  words_at: 1_000_000,
  stale: null,
  counts: {},
  surface: { panel: {}, board: BOARD, tray: {} },
  unattached: {
    tray: [{ section: 'approvals', pos: 1, row: approval('loose', 100) }],
    index: [],
    findings: [
      { pos: 2, row: finding('loose-row', 50) },
      { pos: 0, row: finding('shadowed', 1) },
    ],
  },
  items: [
    {
      id: 'i1',
      state: 'open',
      words: { v: 1, finding: { pos: 1, row: finding('disk-row', 100) } },
    },
    {
      id: 'i2',
      state: 'open',
      words: { v: 1, finding: { pos: 0, row: finding('auth-row', 3600) } },
    },
    {
      id: 'i3',
      state: 'open',
      words: { v: 1, finding: { pos: 1, row: finding('same-board-row', 9) } },
    },
    {
      id: 'i4',
      state: 'needs_you',
      words: { v: 1, tray: { section: 'approvals', pos: 2, row: approval('late', 300) } },
    },
    {
      id: 'i5',
      state: 'needs_you',
      words: { v: 1, tray: { section: 'approvals', pos: 0, row: approval('first', 600) } },
    },
    {
      id: 'i6',
      state: 'needs_you',
      words: { v: 1, tray: { section: 'approvals', pos: 3, row: approval('lapsing', 8) } },
    },
    {
      id: 'i7',
      state: 'open',
      words: { v: 1, tray: { section: 'needs', pos: 0, row: approval('a-need', 600) } },
    },
    { id: 'i8', state: 'over', words: { v: 1, threads: [{ pos: 0 }] } },
  ],
}

function answering(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch
}

describe('readNightshiftView', () => {
  it("composes the owner view from Nightshift's item store, as its /api/view did", async () => {
    const fetchImpl = answering(200, ITEMS)
    const result = await readNightshiftView({ nightshiftUrl: `${URL}/` }, fetchImpl)
    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe(`${URL}/api/items?list=all`)
    expect(result).toEqual({
      available: true,
      view: {
        version: 1,
        snapshot: BOARD.snapshot,
        generated_at: BOARD.generated_at,
        verdict: BOARD.verdict,
        tiles: BOARD.tiles,
        hosts: BOARD.hosts,
        // one row per board position (the first item's wins), by position, aged by the 10 s since the words
        findings: [
          { ...finding('auth-row', 3610), checked: 15 },
          { ...finding('disk-row', 110), checked: 15 },
          { ...finding('loose-row', 60), checked: 15 },
        ],
        needs_you: 1,
        // by position; one with no time left after 10 s is gone
        approvals: [
          { id: 'first', title: 'Approve first', url: 'https://a/e/first', left: 590 },
          { id: 'loose', title: 'Approve loose', url: 'https://a/e/loose', left: 90 },
          { id: 'late', title: 'Approve late', url: 'https://a/e/late', left: 290 },
        ],
        links: BOARD.links,
      },
    })
  })

  it('says Nightshift is not answering instead of showing anything as fine', async () => {
    const down = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as typeof fetch
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await readNightshiftView({ nightshiftUrl: URL }, down)).toEqual({
      available: false,
      reason: 'not_answering',
    })
    expect(await readNightshiftView({ nightshiftUrl: URL }, answering(502, {}))).toEqual({
      available: false,
      reason: 'not_answering',
    })
    expect(await readNightshiftView({ nightshiftUrl: null })).toEqual({
      available: false,
      reason: 'not_configured',
    })
    quiet.mockRestore()
  })

  it("says so when Nightshift can't read its item store or its words are old", async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refused = answering(503, { error: "the item store can't be read: locked" })
    expect(await readNightshiftView({ nightshiftUrl: URL }, refused)).toEqual({
      available: false,
      reason: 'store_refused',
    })
    const stale = { ...ITEMS, stale: { why: "the item store's words are 400 s old", since: 1 } }
    expect(await readNightshiftView({ nightshiftUrl: URL }, answering(200, stale))).toEqual({
      available: false,
      reason: 'store_stale',
    })
    quiet.mockRestore()
  })

  it('reads only the item list version it knows', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const body of [
      { ...ITEMS, v: 2 },
      { ...ITEMS, items: undefined },
      { ...ITEMS, surface: { board: { ...BOARD, tiles: undefined } } },
      { ...ITEMS, surface: { board: { ...BOARD, snapshot: null } } },
      'not json',
    ])
      expect(await readNightshiftView({ nightshiftUrl: URL }, answering(200, body))).toEqual({
        available: false,
        reason: 'unexpected',
      })
    quiet.mockRestore()
  })
})
