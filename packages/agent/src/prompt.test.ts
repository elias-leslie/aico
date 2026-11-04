import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { promptReader } from './prompt'

describe('promptReader', () => {
  it('reads one prompt per Enter, a bracketed paste as one prompt, and null at the end', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const { next } = promptReader(input, output)
    input.write('first\n\n')
    input.write('\x1b[200~line one\nline two\x1b[201~\n')
    input.end('last')
    expect(await next()).toBe('first')
    expect(await next()).toBe('line one\nline two')
    expect(await next()).toBe('last')
    expect(await next()).toBeNull()
    expect(String(output.read())).toContain('› ')
  })
})
