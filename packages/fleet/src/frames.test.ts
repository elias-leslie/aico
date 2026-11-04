import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Decoder, encodeFrame, MAX_FRAME_BYTES, parseFrame } from './frames'

const fixtures = JSON.parse(
  readFileSync(new URL('../../../contracts/fleet-frames-fixtures.json', import.meta.url), 'utf8'),
) as { name: string; valid: boolean; frame: unknown }[]
const schema = JSON.parse(
  readFileSync(new URL('../../../contracts/fleet-frames.schema.json', import.meta.url), 'utf8'),
)
describe('fleet frame drift fixtures', () => {
  it.each(fixtures)('$name', ({ valid, frame }) => {
    if (!valid) expect(() => parseFrame(frame)).toThrow()
    else {
      expect(parseFrame(frame)).toEqual(frame)
      const decoder = new Decoder()
      const bytes = encodeFrame(parseFrame(frame))
      expect(decoder.push(bytes.subarray(0, 3))).toEqual([])
      expect(decoder.push(bytes.subarray(3))).toEqual([frame])
    }
  })
  it('keeps every frame kind in the schema and fixture corpus', () => {
    const types = schema.oneOf.flatMap(
      (variant: { properties: { type: { const?: string; enum?: string[] } } }) =>
        variant.properties.type.enum ?? [variant.properties.type.const],
    )
    expect(new Set(types)).toEqual(
      new Set(['hello', 'auth', 'control', 'event', 'sync', 'terminal-view']),
    )
    for (const type of types)
      expect(fixtures.some((f) => f.valid && (f.frame as { type: string }).type === type)).toBe(
        true,
      )
  })
  it('refuses oversize frames before allocating their payload', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1)
    expect(() => new Decoder().push(header)).toThrow('too large')
  })
})
