// The JSON Schema subset `aico ask --schema` checks an answer against. Models and the claude
// and agy CLIs enforce a schema loosely, so the answer is checked here, strictly (no type
// coercion). A keyword outside the subset is refused up front, so a schema never passes
// because part of it was ignored.

type Schema = { [key: string]: unknown }

const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'default',
  'examples',
  '$comment',
])
const KEYWORDS = new Set([
  ...ANNOTATIONS,
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'pattern',
  'anyOf',
  'oneOf',
  'allOf',
])

const isObject = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The keywords in `schema` (at any depth) outside the supported subset. */
export function unsupportedKeywords(schema: unknown, path = '#'): string[] {
  if (typeof schema === 'boolean') return []
  if (!isObject(schema)) return [`${path}: a schema must be an object`]
  const out: string[] = []
  for (const [key, value] of Object.entries(schema)) {
    if (!KEYWORDS.has(key)) out.push(`${path}/${key}`)
    else if (key === 'properties' && isObject(value))
      for (const [name, sub] of Object.entries(value))
        out.push(...unsupportedKeywords(sub, `${path}/properties/${name}`))
    else if (key === 'items' || key === 'additionalProperties')
      out.push(...unsupportedKeywords(value, `${path}/${key}`))
    else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value))
      for (const [i, sub] of value.entries())
        out.push(...unsupportedKeywords(sub, `${path}/${key}/${i}`))
  }
  return out
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

const matchesType = (value: unknown, type: string) =>
  typeOf(value) === type || (type === 'number' && typeOf(value) === 'integer')

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What is wrong with `value` against `schema`, one line per problem; empty when it fits. */
export function schemaErrors(schema: unknown, value: unknown, path = '$'): string[] {
  if (schema === true) return []
  if (schema === false) return [`${path}: not allowed`]
  const s = schema as Schema
  const errors: string[] = []
  const types = s.type === undefined ? null : ([] as unknown[]).concat(s.type)
  if (types && !types.some((type) => matchesType(value, String(type))))
    return [`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`]
  if (Array.isArray(s.enum) && !s.enum.some((option) => same(option, value)))
    errors.push(`${path}: not one of ${JSON.stringify(s.enum)}`)
  if ('const' in s && !same(s.const, value))
    errors.push(`${path}: must be ${JSON.stringify(s.const)}`)
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength)
      errors.push(`${path}: shorter than ${s.minLength}`)
    if (typeof s.maxLength === 'number' && value.length > s.maxLength)
      errors.push(`${path}: longer than ${s.maxLength}`)
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value))
      errors.push(`${path}: does not match ${s.pattern}`)
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum)
      errors.push(`${path}: below ${s.minimum}`)
    if (typeof s.maximum === 'number' && value > s.maximum)
      errors.push(`${path}: above ${s.maximum}`)
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems)
      errors.push(`${path}: fewer than ${s.minItems} items`)
    if (typeof s.maxItems === 'number' && value.length > s.maxItems)
      errors.push(`${path}: more than ${s.maxItems} items`)
    if (s.items !== undefined)
      for (const [i, item] of value.entries())
        errors.push(...schemaErrors(s.items, item, `${path}[${i}]`))
  }
  if (isObject(value)) {
    const properties = isObject(s.properties) ? s.properties : {}
    for (const name of Array.isArray(s.required) ? s.required : [])
      if (!(name in value)) errors.push(`${path}: missing '${name}'`)
    for (const [name, item] of Object.entries(value)) {
      if (name in properties)
        errors.push(...schemaErrors(properties[name], item, `${path}.${name}`))
      else if (s.additionalProperties === false) errors.push(`${path}: unexpected '${name}'`)
      else if (s.additionalProperties !== undefined && s.additionalProperties !== true)
        errors.push(...schemaErrors(s.additionalProperties, item, `${path}.${name}`))
    }
  }
  if (Array.isArray(s.allOf))
    for (const sub of s.allOf) errors.push(...schemaErrors(sub, value, path))
  if (Array.isArray(s.anyOf) && !s.anyOf.some((sub) => !schemaErrors(sub, value, path).length))
    errors.push(`${path}: fits none of the anyOf options`)
  if (Array.isArray(s.oneOf)) {
    const fits = s.oneOf.filter((sub) => !schemaErrors(sub, value, path).length).length
    if (fits !== 1) errors.push(`${path}: fits ${fits} of the oneOf options, not exactly one`)
  }
  return errors
}

/** The JSON in a model's reply: the whole text, or the content of a ``` fence, or null. */
export function jsonIn(text: string): { value: unknown } | null {
  const candidates = [text.trim()]
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text)
  if (fence) candidates.push((fence[1] as string).trim())
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) }
    } catch {
      // try the next form
    }
  }
  return null
}
