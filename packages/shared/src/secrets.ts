// Hides secret-looking strings (API tokens, keys, passwords) in text shown as
// a preview, so a glance at a list or a shared screen doesn't reveal them.
// The full text stays where its owner edits it; this is only for excerpts.

import shapes from '../data/secret-shapes.json' with { type: 'json' }

export const HIDDEN_TOKEN = '•••• (hidden: looks like a token)'
export const HIDDEN_PASSWORD = '•••• (hidden: looks like a password)'
export const HIDDEN_KEY = '•••• (hidden: looks like a private key)'

// Exact token shapes live in data/secret-shapes.json.
const KNOWN_TOKENS: RegExp[] = shapes.shapes.map((shape) => new RegExp(shape.pattern, 'g'))
const PRIVATE_KEY = new RegExp(shapes.privateKey, 'g')
/** The exact shape: a digit somewhere in the value, so prose after "Bearer" stays visible. */
const BEARER = new RegExp(shapes.bearer, 'g')
/** The broad shape for previews of text the owner wrote (Notes, project files): any 12+ characters. */
const BEARER_BROAD = new RegExp(shapes.bearerBroad, 'g')
/** `NAME=value`, `NAME: value`, `"name": "value"` for a secret-like name: the value only. */
const ASSIGNMENTS = shapes.assignment.values.map(
  (value) => new RegExp(value.replaceAll('{name}', shapes.assignment.name), 'gi'),
)

/** `password: X`, `api_key=X`, `BOT_TOKEN = "X"`: the label stays, the value goes. */
const LABELLED =
  /\b([A-Za-z_-]*?(password|passwd|passphrase|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z_-]*)(\s*[:=]\s*)(["']?)([^\s"'•]+)\4/gi

/** A long run of key-like characters. */
const LONG_RUN = /[A-Za-z0-9+/_=-]{32,}/g

function entropy(text: string): number {
  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / text.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/** Random-looking: all hex, or mixed case with digits and little repetition. */
function looksRandom(run: string): boolean {
  if (/^[0-9a-fA-F]{32,}$/.test(run)) return /[0-9]/.test(run) && /[a-fA-F]/.test(run)
  const core = run.replace(/=+$/, '')
  return /[a-z]/.test(core) && /[A-Z]/.test(core) && /[0-9]/.test(core) && entropy(core) >= 4
}

/** `text` with only well-defined secret shapes hidden: known service tokens, private key blocks,
 * `Bearer` values with a digit, values assigned to a secret-like name. No guessing from length or randomness, so git hashes, UUIDs and base64 data
 * stay visible. For transcripts, where the broad mask in `maskSecrets` hid ordinary text. */
export function maskKnownSecrets(text: string): string {
  if (!text) return text
  let out = text.replace(PRIVATE_KEY, HIDDEN_KEY)
  out = out.replace(BEARER, (_all, prefix: string) => `${prefix}${HIDDEN_TOKEN}`)
  for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, HIDDEN_TOKEN)
  for (const pattern of ASSIGNMENTS) out = out.replace(pattern, HIDDEN_TOKEN)
  return out
}

/** `text` with anything that looks like a secret replaced by a short notice. */
export function maskSecrets(text: string): string {
  if (!text) return text
  let out = text.replace(PRIVATE_KEY, HIDDEN_KEY)
  out = out.replace(LABELLED, (_all, label: string, kind: string, sep: string) => {
    const word = /pass|pwd/i.test(kind) ? HIDDEN_PASSWORD : HIDDEN_TOKEN
    return `${label}${sep}${word}`
  })
  out = out.replace(BEARER_BROAD, (_all, prefix: string) => `${prefix}${HIDDEN_TOKEN}`)
  for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, HIDDEN_TOKEN)
  return out.replace(LONG_RUN, (run) => (looksRandom(run) ? HIDDEN_TOKEN : run))
}
