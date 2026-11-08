import { describe, expect, it } from 'vitest'
import { InputLine } from './input-line'

const typed = (data: string) => new InputLine().feed(data)

describe('InputLine', () => {
  it('rebuilds a typed line with its edits', () => {
    expect(typed('helloo\u007f wor\u0017world\r')).toEqual([{ text: 'hello world', approx: false }])
    expect(typed('gone\u0015kept\r')).toEqual([{ text: 'kept', approx: false }])
    expect(typed('gone\u0003\r')).toEqual([])
  })

  it('takes more than one line from one frame, and non-ASCII whole', () => {
    expect(typed('a\rb\r').map((line) => line.text)).toEqual(['a', 'b'])
    expect(typed('café \u{1f600}\u007f\r').map((line) => line.text)).toEqual(['café '])
  })

  it('takes a composer paste and a bracketed paste across frames', () => {
    const line = new InputLine()
    line.paste('from the composer')
    expect(line.feed('\r')).toEqual([{ text: 'from the composer', approx: false }])
    expect(line.feed('\u001b[200~first ')).toEqual([])
    expect(line.feed('half\rstill pasted\u001b[201~\r')).toEqual([
      { text: 'first half\rstill pasted', approx: false },
    ])
  })

  it('marks the text when keys moved the cursor', () => {
    expect(typed('ab\u001b[Dc\r')).toEqual([{ text: 'abc', approx: true }])
    expect(typed('ab\u0001c\r')).toEqual([{ text: 'abc', approx: true }])
  })

  it("ignores what isn't the owner's editing", () => {
    const quiet =
      'a\u001b[I\u001b[O\u001b[<0;10;5M\u001b[Mabc\u001b[12;40R\u001b]11;rgb:0/0/0\u0007b\r'
    expect(typed(quiet)).toEqual([{ text: 'ab', approx: false }])
  })

  it('leaves out slash commands and shell lines', () => {
    expect(typed('/compact\r')).toEqual([])
    expect(typed('!sudo thing\r')).toEqual([])
  })

  it('keeps a message that starts with a path', () => {
    expect(typed('/srv/app is broken, check it\r')).toEqual([
      { text: '/srv/app is broken, check it', approx: false },
    ])
  })

  it('leaves out the line after a command: its dialog may have asked for a key', () => {
    const line = new InputLine()
    expect(line.feed('/login\r')).toEqual([])
    expect(line.feed('sk-secret\r')).toEqual([])
    expect(line.feed('a real message\r')).toEqual([{ text: 'a real message', approx: false }])
    line.feed('/login\r')
    line.feed('half a key')
    expect(line.take()).toBeNull()
  })

  it('leaves commands and shell lines out of what was in progress', () => {
    const line = new InputLine()
    line.feed('!export TOKEN=abc')
    expect(line.take()).toBeNull()
  })

  it('hands over what was in progress once', () => {
    const line = new InputLine()
    line.feed('half a tho')
    expect(line.take()).toEqual({ text: 'half a tho', approx: false })
    expect(line.take()).toBeNull()
  })

  it('stops growing at its cap and says so', () => {
    const line = new InputLine()
    line.paste('x'.repeat(70_000))
    const taken = line.take()
    expect(taken?.text.length).toBe(64 * 1024)
    expect(taken?.approx).toBe(true)
  })
})
