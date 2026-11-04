// notice.ts agrees with contracts/notice.schema.json and replays
// contracts/notice-fixtures.json.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACTIONS, KINDS, LIMITS, NoticeError, PUSH, parseNotice, SEVERITIES } from './notice'

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8'))
const schema = read('contracts/notice.schema.json')
const fixtures = read('contracts/notice-fixtures.json')
const props = schema.properties

describe('notice.ts matches the schema', () => {
  it('has the same fields, lists and limits', () => {
    expect(schema.required).toEqual(['v', 'source', 'title', 'body'])
    expect(schema.additionalProperties).toBe(false)
    expect(props.kind.enum).toEqual([...KINDS])
    expect(props.severity.enum).toEqual([...SEVERITIES])
    expect(props.actions.items.enum).toEqual([...ACTIONS])
    expect(props.primary.enum).toEqual([...ACTIONS])
    expect(props.push.enum).toEqual([...PUSH])
    expect(props.source.pattern).toBe(LIMITS.source.pattern.source)
    expect(props.key.pattern).toBe(LIMITS.key.pattern.source)
    for (const field of ['title', 'body', 'command', 'if_ignored'] as const) {
      expect(props[field].minLength).toBe(LIMITS[field].min)
      expect(props[field].maxLength).toBe(LIMITS[field].max)
    }
    expect(props.detail.maxLength).toBe(LIMITS.detail.max)
    expect(props.open.maxLength).toBe(LIMITS.open.max)
    expect(props.fields.maxItems).toBe(LIMITS.fields.max)
    expect(props.fields.items.properties.label.maxLength).toBe(LIMITS.fields.label)
    expect(props.fields.items.properties.value.maxLength).toBe(LIMITS.fields.value)
    for (const field of ['cooldown', 'expires'] as const) {
      expect(props[field].minimum).toBe(LIMITS[field].min)
      expect(props[field].maximum).toBe(LIMITS[field].max)
    }
  })
})

describe('the fixtures', () => {
  for (const fixture of fixtures.valid)
    it(`accepts ${fixture.name}`, () => {
      expect(parseNotice(fixture.notice)).toEqual(fixture.expect)
    })
  for (const fixture of fixtures.invalid)
    it(`refuses ${fixture.name}`, () => {
      let error: unknown
      try {
        parseNotice(fixture.notice)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(NoticeError)
      expect((error as NoticeError).field).toBe(fixture.field)
    })
})
