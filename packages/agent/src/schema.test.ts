import { describe, expect, it } from 'vitest'
import { compileSchema } from './schema'

function errors(schema: unknown, value: unknown): string[] {
  const compiled = compileSchema(schema)
  if ('error' in compiled) throw new Error(compiled.error)
  return compiled.validate(value)
}

describe('JSON Schema conformance', () => {
  it('does not coerce types and enforces required and additional fields', () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'integer' } },
      required: ['answer'],
      additionalProperties: false,
    }
    expect(errors(schema, { answer: 42 })).toEqual([])
    expect(errors(schema, { answer: '42' })).not.toEqual([])
    expect(errors(schema, {})).not.toEqual([])
    expect(errors(schema, { answer: 42, more: 2 })).not.toEqual([])
  })
  it('counts only own properties for required and additionalProperties', () => {
    const schema = {
      type: 'object',
      properties: { constructor: { type: 'string' } },
      required: ['constructor'],
    }
    expect(errors(schema, {})).not.toEqual([])
    expect(errors(schema, { constructor: 'present' })).toEqual([])
    expect(
      errors(
        { type: 'object', additionalProperties: false },
        JSON.parse('{"toString":"unexpected"}'),
      ),
    ).not.toEqual([])
  })
  it('compares object const and enum structurally, without key order', () => {
    expect(errors({ const: { a: 1, b: 2 } }, { b: 2, a: 1 })).toEqual([])
    expect(errors({ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 })).toEqual([])
    expect(errors({ const: { a: 1, b: 2 } }, { b: 3, a: 1 })).not.toEqual([])
  })
  it('counts Unicode code points for string length', () => {
    expect(errors({ type: 'string', minLength: 1, maxLength: 1 }, '😀')).toEqual([])
    expect(errors({ type: 'string', minLength: 2 }, '😀')).not.toEqual([])
  })
  it('supports 2020-12 schemas and local references', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { answer: { type: 'integer' } },
      type: 'object',
      properties: { answer: { $ref: '#/$defs/answer' } },
      required: ['answer'],
    }
    expect(errors(schema, { answer: 42 })).toEqual([])
    expect(errors(schema, { answer: 'no' })).not.toEqual([])
  })
  it.each([
    { type: 'string', pattern: '[' },
    { type: 'string', unknownKeyword: true },
    { type: 'array', minItems: 'x' },
    { $async: true, type: 'string' },
  ])('returns a compile error for an invalid or unsupported schema', (schema) => {
    expect(compileSchema(schema)).toHaveProperty('error')
  })
})
