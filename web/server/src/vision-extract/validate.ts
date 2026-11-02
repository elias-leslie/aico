// A small JSON Schema checker for what vision-extract accepts: `type` (one name
// or a list), `properties`, `required`, `items` and `enum`. Anything the model
// returns that does not fit is a failed read, never stored.

export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function fits(value: unknown, name: string): boolean {
  const actual = typeOf(value)
  return actual === name || (name === 'number' && actual === 'integer')
}

/** The first mismatch as `path: what is wrong`, or null when the value fits. */
export function validate(value: unknown, schema: JsonSchema, path = '$'): string | null {
  if (schema.type !== undefined) {
    const names = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!names.some((name) => fits(value, name)))
      return `${path}: expected ${names.join(' or ')}, got ${typeOf(value)}`
  }
  if (schema.enum && !schema.enum.includes(value))
    return `${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const problem = validate(value[index], schema.items, `${path}[${index}]`)
      if (problem) return problem
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    for (const key of schema.required ?? [])
      if (!(key in object)) return `${path}: missing "${key}"`
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!(key in object)) continue
      const problem = validate(object[key], child, `${path}.${key}`)
      if (problem) return problem
    }
  }
  return null
}
