// JSON the way Agent Hub's `st web` printed it (Python json.dumps, sort_keys=True,
// ensure_ascii), so callers that parse or diff the output see the same text.

const jsonText = (text: string) =>
  JSON.stringify(text).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

/** `indent` 2 for the default view, null for --compact (one line). */
export function pyJson(value: unknown, indent: number | null = 2, depth = 0): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return jsonText(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  const pad = indent === null ? '' : `\n${' '.repeat(indent * (depth + 1))}`
  const close = indent === null ? '' : `\n${' '.repeat(indent * depth)}`
  const sep = indent === null ? ', ' : `,${pad}`
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    return `[${indent === null ? '' : pad}${value.map((item) => pyJson(item, indent, depth + 1)).join(sep)}${close}]`
  }
  const keys = Object.keys(value as object)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
  if (!keys.length) return '{}'
  const body = keys
    .map(
      (key) =>
        `${jsonText(key)}: ${pyJson((value as Record<string, unknown>)[key], indent, depth + 1)}`,
    )
    .join(sep)
  return `{${indent === null ? '' : pad}${body}${close}}`
}
