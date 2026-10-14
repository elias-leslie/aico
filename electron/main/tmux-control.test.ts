import { describe, expect, it, vi } from 'vitest'
import {
  buildSeed,
  ControlProtocol,
  controlArgv,
  decodeOutputValue,
  inputCommands,
  parseSeedFlags,
  SEED_FLAGS,
  type SeedFlags,
} from './tmux-control'

const ESC = '\x1b'

function flags(overrides: Partial<SeedFlags> = {}): SeedFlags {
  return {
    paneId: '%3',
    alternate_on: 0,
    alternate_saved_x: 0,
    alternate_saved_y: 0,
    cursor_x: 4,
    cursor_y: 1,
    cursor_flag: 1,
    insert_flag: 0,
    keypad_cursor_flag: 0,
    keypad_flag: 0,
    wrap_flag: 1,
    origin_flag: 0,
    mouse_standard_flag: 0,
    mouse_button_flag: 0,
    mouse_any_flag: 0,
    mouse_sgr_flag: 0,
    scroll_region_upper: 0,
    scroll_region_lower: 23,
    ...overrides,
  }
}

describe('decodeOutputValue', () => {
  it('turns octal escapes back into bytes and keeps everything else', () => {
    expect([...decodeOutputValue('a\\015\\012\\134b')]).toEqual([0x61, 0x0d, 0x0a, 0x5c, 0x62])
  })

  it('keeps a backslash that does not start an escape', () => {
    expect(decodeOutputValue('x\\9y\\').toString('latin1')).toBe('x\\9y\\')
  })

  it('passes raw UTF-8 bytes through unchanged', () => {
    const raw = Buffer.from('❯ é', 'utf8').toString('latin1')
    expect(decodeOutputValue(raw).toString('utf8')).toBe('❯ é')
  })
})

describe('parseSeedFlags', () => {
  it('reads the pane id and every flag in order', () => {
    const values = SEED_FLAGS.map((_, i) => (i === 0 ? '%7' : String(i)))
    const parsed = parseSeedFlags(values.join(' '))
    expect(parsed?.paneId).toBe('%7')
    expect(parsed?.alternate_on).toBe(1)
    expect(parsed?.scroll_region_lower).toBe(SEED_FLAGS.length - 1)
  })

  it('rejects a malformed or short line', () => {
    expect(parseSeedFlags('')).toBeNull()
    expect(parseSeedFlags('%1 0 0')).toBeNull()
    expect(parseSeedFlags(['x', ...SEED_FLAGS.slice(1).map(() => '0')].join(' '))).toBeNull()
  })
})

describe('buildSeed', () => {
  it('resets, writes history and screen, then places the cursor', () => {
    const seed = buildSeed(flags(), ['one', 'two'], [], 24)
    expect(seed.startsWith(`${ESC}c`)).toBe(true)
    expect(seed).toContain(`one${ESC}[0m\r\ntwo${ESC}[0m`)
    expect(seed).toContain(`${ESC}[1;24r`)
    expect(seed.endsWith(`${ESC}[2;5H`)).toBe(true)
  })

  it('puts the saved normal screen under an alternate one', () => {
    const screen = ['h1', 'h2', 'alt1', 'alt2']
    const seed = buildSeed(
      flags({ alternate_on: 1, alternate_saved_x: 2, alternate_saved_y: 1 }),
      screen,
      ['n1', 'n2'],
      2,
    )
    const normalAt = seed.indexOf(`h1${ESC}[0m\r\nh2${ESC}[0m\r\nn1${ESC}[0m\r\nn2`)
    const switchAt = seed.indexOf(`${ESC}[2;3H${ESC}[?1049h${ESC}[H`)
    const altAt = seed.indexOf(`alt1${ESC}[0m\r\nalt2`)
    expect(normalAt).toBeGreaterThan(0)
    expect(switchAt).toBeGreaterThan(normalAt)
    expect(altAt).toBeGreaterThan(switchAt)
  })

  it('restores the modes tmux reports', () => {
    const seed = buildSeed(
      flags({
        cursor_flag: 0,
        wrap_flag: 0,
        insert_flag: 1,
        keypad_cursor_flag: 1,
        keypad_flag: 1,
        origin_flag: 1,
        mouse_button_flag: 1,
        mouse_any_flag: 1,
        mouse_sgr_flag: 1,
      }),
      ['x'],
      [],
      24,
    )
    for (const mode of ['[?25l', '[?7l', '[4h', '[?1h', '=', '[?6h', '[?1002h', '[?1006h'])
      expect(seed).toContain(`${ESC}${mode}`)
    expect(seed).not.toContain(`${ESC}[?1003h`)
  })

  it('asks for any-event tracking when that is the only mouse mode', () => {
    expect(buildSeed(flags({ mouse_any_flag: 1 }), ['x'], [], 24)).toContain(`${ESC}[?1003h`)
  })
})

describe('controlArgv', () => {
  it('turns the attach argv into a control client with backlog pausing', () => {
    expect(controlArgv(['/usr/bin/tmux', '-S', '/s.sock', 'attach-session', '-t', 'main'])).toEqual(
      [
        '/usr/bin/tmux',
        '-C',
        '-S',
        '/s.sock',
        'attach-session',
        '-t',
        'main',
        '-f',
        'pause-after=5',
      ],
    )
  })

  it('refuses an argv that does not attach', () => {
    expect(() => controlArgv(['tmux', 'new-session'])).toThrow()
  })
})

describe('inputCommands', () => {
  it('types bytes as hex keys into the pane, in bounded chunks', () => {
    expect(inputCommands('%2', Buffer.from('a\x1b'))).toEqual(['send-keys -t %2 -H 61 1b'])
    const long = inputCommands('%2', Buffer.alloc(1100, 0x61))
    expect(long).toHaveLength(3)
    expect(long[2].split(' ').length).toBe(4 + 76)
  })
})

describe('ControlProtocol', () => {
  function protocol() {
    const output = vi.fn()
    const pause = vi.fn()
    const exit = vi.fn()
    return { p: new ControlProtocol({ output, pause, exit }), output, pause, exit }
  }

  it('skips the block tmux opens the session with and matches replies in order', () => {
    const { p } = protocol()
    const replies: string[][] = []
    p.expect(2, (blocks) => replies.push(...blocks.map((b) => b.lines)))
    p.feed(Buffer.from('%begin 1 1 0\n%end 1 1 0\n'))
    p.feed(Buffer.from('%begin 1 2 1\nfirst\n%end 1 2 1\n%begin 1 3 1\nsec'))
    expect(replies).toEqual([])
    p.feed(Buffer.from('ond\n%end 1 3 1\n'))
    expect(replies).toEqual([['first'], ['second']])
  })

  it('decodes reply text as UTF-8', () => {
    const { p } = protocol()
    let line = ''
    p.expect(1, ([block]) => {
      line = block.lines[0]
    })
    p.feed(
      Buffer.concat([
        Buffer.from('%begin 1 2 1\n'),
        Buffer.from('❯ • é\n'),
        Buffer.from('%end 1 2 1\n'),
      ]),
    )
    expect(line).toBe('❯ • é')
  })

  it('reports pane output, extended output, pauses and exit', () => {
    const { p, output, pause, exit } = protocol()
    p.feed(Buffer.from('%output %1 hi\\015\\012\n%extended-output %1 12 : yo\n%pause %1\n%exit\n'))
    expect(output.mock.calls.map(([pane, bytes]) => [pane, bytes.toString()])).toEqual([
      ['%1', 'hi\r\n'],
      ['%1', 'yo'],
    ])
    expect(pause).toHaveBeenCalledWith('%1')
    expect(exit).toHaveBeenCalled()
  })

  it('ignores a pause notice inside a reply instead of taking it as reply text', () => {
    const { p } = protocol()
    let lines: string[] = []
    p.expect(1, ([block]) => {
      lines = block.lines
    })
    p.feed(Buffer.from('%begin 1 2 1\n%continue %0\n%end 1 2 1\n'))
    expect(lines).toEqual([])
  })

  it('lets a reply handler act before the output that follows its %end', () => {
    const order: string[] = []
    const p = new ControlProtocol({
      output: (_pane, bytes) => order.push(`out:${bytes.toString()}`),
      pause: () => {},
      exit: () => {},
    })
    p.expect(1, () => order.push('reply'))
    p.feed(Buffer.from('%output %1 before\n%begin 1 2 1\n%end 1 2 1\n%output %1 after\n'))
    expect(order).toEqual(['out:before', 'reply', 'out:after'])
  })
})
