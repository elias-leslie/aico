// The line an owner is typing into an agent session, rebuilt from what one socket
// sends, so Tether can hold on to it until it shows up in the agent's record
// (packages/tether/src/pending-input.ts). Only a guide: when keys move the cursor
// the text may differ, and that is marked. Never used for shell sessions.

const MAX_LINE_CHARS = 64 * 1024
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
/** Final bytes of what a terminal says on its own or a mouse sends, not the owner's edits. */
const NOT_EDITS = new Set(['I', 'O', 'M', 'm', 'R', 'c', 'n', 't'])
/** Slash commands and `!` shell lines aren't messages; a path like /srv/x is. */
const COMMAND_LINE = /^\s*(!|\/[^\s/]+(\s|$))/

export interface TakenLine {
  text: string
  approx: boolean
}

export class InputLine {
  private text = ''
  private approx = false
  private pasting = false
  /** A command's dialog may ask for a key or code on the next line: that's no message. */
  private afterCommand = false

  private append(text: string): void {
    const room = MAX_LINE_CHARS - this.text.length
    if (text.length > room) this.approx = true
    this.text += text.slice(0, Math.max(0, room))
  }

  private clear(): void {
    this.text = ''
    this.approx = false
  }

  /** A paste arriving whole, not as keystrokes. */
  paste(text: string): void {
    this.append(text)
  }

  /** Feed keystrokes; returns the lines they submitted. */
  feed(data: string): TakenLine[] {
    const lines: TakenLine[] = []
    let at = 0
    while (at < data.length) {
      if (this.pasting) {
        const end = data.indexOf(PASTE_END, at)
        this.append(end < 0 ? data.slice(at) : data.slice(at, end))
        if (end < 0) break
        this.pasting = false
        at = end + PASTE_END.length
        continue
      }
      const code = data.charCodeAt(at)
      if (code === 0x1b) {
        if (data.startsWith(PASTE_START, at)) {
          this.pasting = true
          at += PASTE_START.length
        } else at = this.escape(data, at)
        continue
      }
      at += 1
      if (code === 0x0d) {
        const line = this.takeSubmitted()
        if (line) lines.push(line)
      } else if (code === 0x7f || code === 0x08) this.text = [...this.text].slice(0, -1).join('')
      else if (code === 0x15 || code === 0x03) this.clear()
      else if (code === 0x17) this.text = this.text.replace(/\S+\s*$/, '')
      else if (code === 0x0a) this.append('\n')
      else if (code < 0x20) this.approx = true
      else {
        const point = data.codePointAt(at - 1) ?? code
        const character = String.fromCodePoint(point)
        this.append(character)
        at += character.length - 1
      }
    }
    return lines
  }

  /** Skips one escape sequence; anything that may edit the line marks it. */
  private escape(data: string, start: number): number {
    const next = data[start + 1]
    if (next === ']') {
      // A terminal's answer (colours, title): to its BEL or ST.
      for (let at = start + 2; at < data.length; at += 1) {
        if (data[at] === '\u0007') return at + 1
        if (data[at] === '\u001b') return at + 2
      }
      return data.length
    }
    if (next === '[') {
      let at = start + 2
      while (at < data.length && !/[@-~]/.test(data[at] as string)) at += 1
      const final = data[at]
      // The old mouse form carries three raw bytes after its M.
      if (final === 'M' && at === start + 2) return at + 4
      if (!final || !NOT_EDITS.has(final)) this.approx = true
      return at + 1
    }
    this.approx = true
    return start + (next === 'O' ? 3 : 2)
  }

  private takeSubmitted(): TakenLine | null {
    const line = this.takeRaw()
    if (!line) return null
    const keep = !this.afterCommand && !COMMAND_LINE.test(line.text)
    this.afterCommand = COMMAND_LINE.test(line.text)
    return keep ? line : null
  }

  /** What's in progress, emptied, if it's a message. */
  take(): TakenLine | null {
    const line = this.takeRaw()
    return line && !this.afterCommand && !COMMAND_LINE.test(line.text) ? line : null
  }

  private takeRaw(): TakenLine | null {
    const line = this.text.trim() ? { text: this.text, approx: this.approx } : null
    this.clear()
    return line
  }
}
