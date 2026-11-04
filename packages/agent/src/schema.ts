// Compile JSON Schema before a model runs. Ajv checks the schema and the answer,
// with no coercion and only the JSON value's own properties.
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js'

export type CompiledSchema = { validate(value: unknown): string[] } | { error: string }

export function compileSchema(schema: unknown): CompiledSchema {
  try {
    if (
      typeof schema !== 'boolean' &&
      (schema === null || typeof schema !== 'object' || Array.isArray(schema))
    )
      return { error: 'a schema must be an object or boolean' }
    const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true })
    const check = ajv.compile(schema as AnySchema)
    if ('$async' in check && check.$async)
      return { error: 'asynchronous schemas are not supported' }
    return {
      validate(value) {
        if (check(value)) return []
        return (check.errors ?? []).map((error) => ajv.errorsText([error], { dataVar: '$' }))
      },
    }
  } catch (error) {
    return { error: (error as Error).message }
  }
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
      /* try the next form */
    }
  }
  return null
}
