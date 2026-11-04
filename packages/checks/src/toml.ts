// The part of TOML that .st-check.toml files use: tables, arrays of tables, bare or quoted keys,
// strings (basic, literal and multi-line), integers, floats, booleans, arrays and inline tables.
// Anything else (dates, dotted keys) is an error naming the line, so a config never half-loads.

export type TomlTable = { [key: string]: unknown }

export class TomlError extends Error {}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {}
  let table = root
  let i = 0
  const line = () => text.slice(0, i).split('\n').length
  const fail = (message: string): never => {
    throw new TomlError(`TOML line ${line()}: ${message}`)
  }
  const space = () => {
    while (text[i] === ' ' || text[i] === '\t') i++
  }
  const comment = () => {
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++
  }
  // Whitespace, newlines and comments (between statements and inside arrays).
  const blank = () => {
    for (;;) {
      space()
      comment()
      if (text[i] === '\n' || text[i] === '\r') i++
      else return
    }
  }
  const endOfLine = () => {
    space()
    comment()
    if (i < text.length && text[i] !== '\n' && text[i] !== '\r')
      fail('expected the end of the line')
  }

  const key = (): string => {
    space()
    if (text[i] === '"' || text[i] === "'") return string()
    const start = i
    while (i < text.length && /[A-Za-z0-9_-]/.test(text[i])) i++
    if (i === start) fail('expected a key')
    return text.slice(start, i)
  }
  const keyPath = (close: string): string[] => {
    const path = [key()]
    for (;;) {
      space()
      if (text.startsWith(close, i)) {
        i += close.length
        return path
      }
      if (text[i] !== '.') fail(`expected . or ${close}`)
      i++
      path.push(key())
    }
  }

  const escapes: Record<string, string> = {
    b: '\b',
    t: '\t',
    n: '\n',
    f: '\f',
    r: '\r',
    '"': '"',
    '\\': '\\',
  }
  const string = (): string => {
    const quote = text[i]
    const multi = text.startsWith(quote.repeat(3), i)
    i += multi ? 3 : 1
    if (multi && text[i] === '\n') i++
    let out = ''
    for (;;) {
      if (i >= text.length) fail('unterminated string')
      if (multi ? text.startsWith(quote.repeat(3), i) : text[i] === quote) {
        i += multi ? 3 : 1
        return out
      }
      const c = text[i]
      if (c === '\n' && !multi) fail('newline in a string')
      if (c === '\\' && quote === '"') {
        const e = text[i + 1]
        if (e === 'u' || e === 'U') {
          const n = e === 'u' ? 4 : 8
          const hex = text.slice(i + 2, i + 2 + n)
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) fail('bad unicode escape')
          out += String.fromCodePoint(Number.parseInt(hex, 16))
          i += 2 + n
          continue
        }
        if (multi && (e === '\n' || e === ' ' || e === '\t')) {
          i++
          while (/[ \t\r\n]/.test(text[i] ?? '')) i++
          continue
        }
        if (!(e in escapes)) fail(`bad escape \\${e}`)
        out += escapes[e]
        i += 2
        continue
      }
      out += c
      i++
    }
  }

  const value = (): unknown => {
    space()
    const c = text[i]
    if (c === '"' || c === "'") return string()
    if (c === '[') {
      i++
      const items: unknown[] = []
      for (;;) {
        blank()
        if (text[i] === ']') {
          i++
          return items
        }
        items.push(value())
        blank()
        if (text[i] === ',') i++
        else if (text[i] !== ']') fail('expected , or ] in an array')
      }
    }
    if (c === '{') {
      i++
      const inline: TomlTable = {}
      space()
      if (text[i] === '}') {
        i++
        return inline
      }
      for (;;) {
        const k = key()
        space()
        if (text[i] !== '=') fail('expected =')
        i++
        if (k in inline) fail(`duplicate key ${k}`)
        inline[k] = value()
        space()
        if (text[i] === '}') {
          i++
          return inline
        }
        if (text[i] !== ',') fail('expected , or } in an inline table')
        i++
      }
    }
    const word = /^[A-Za-z0-9_.+-]+/.exec(text.slice(i))?.[0] ?? ''
    i += word.length
    if (word === 'true') return true
    if (word === 'false') return false
    const plain = word.replace(/_/g, '')
    if (/^[+-]?\d+$/.test(plain)) return Number.parseInt(plain, 10)
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(plain)) return Number.parseFloat(plain)
    return fail(`unsupported value ${JSON.stringify(word || text[i])}`)
  }

  // The table at path, creating plain tables on the way; the last element of an array of tables.
  const walk = (path: string[]): TomlTable => {
    let at = root
    for (const part of path) {
      let next = at[part]
      if (next === undefined) {
        next = {}
        at[part] = next
      }
      if (Array.isArray(next)) next = next[next.length - 1]
      if (typeof next !== 'object' || next === null) fail(`${part} is not a table`)
      at = next as TomlTable
    }
    return at
  }

  for (;;) {
    blank()
    if (i >= text.length) return root
    if (text.startsWith('[[', i)) {
      i += 2
      const path = keyPath(']]')
      const parent = walk(path.slice(0, -1))
      const last = path[path.length - 1]
      parent[last] ??= []
      const list = parent[last]
      if (!Array.isArray(list)) fail(`${path.join('.')} is not an array of tables`)
      table = {}
      ;(list as TomlTable[]).push(table)
    } else if (text[i] === '[') {
      i++
      table = walk(keyPath(']'))
    } else {
      const k = key()
      space()
      if (text[i] !== '=') fail(`expected = after ${k}`)
      i++
      if (k in table) fail(`duplicate key ${k}`)
      table[k] = value()
    }
    endOfLine()
  }
}
