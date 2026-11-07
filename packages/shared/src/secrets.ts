// Hides secret-looking strings (API tokens, keys, passwords) in text shown as
// a preview, so a glance at a list or a shared screen doesn't reveal them.
// The full text stays where its owner edits it; this is only for excerpts.

export const HIDDEN_TOKEN = '•••• (hidden: looks like a token)'
export const HIDDEN_PASSWORD = '•••• (hidden: looks like a password)'
export const HIDDEN_KEY = '•••• (hidden: looks like a private key)'

/** Shapes issued by well-known services. */
const KNOWN_TOKENS: RegExp[] = [
  /\b\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, // Telegram bot token
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic and similar
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, // GitHub
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
]

const PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g

/** `password: X`, `api_key=X`, `BOT_TOKEN = "X"`: the label stays, the value goes. */
const LABELLED =
  /\b([A-Za-z_-]*?(password|passwd|passphrase|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z_-]*)(\s*[:=]\s*)(["']?)([^\s"'•]+)\4/gi

const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g

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

/** `text` with anything that looks like a secret replaced by a short notice. */
export function maskSecrets(text: string): string {
  if (!text) return text
  let out = text.replace(PRIVATE_KEY, HIDDEN_KEY)
  out = out.replace(LABELLED, (_all, label: string, kind: string, sep: string) => {
    const word = /pass|pwd/i.test(kind) ? HIDDEN_PASSWORD : HIDDEN_TOKEN
    return `${label}${sep}${word}`
  })
  out = out.replace(BEARER, (_all, prefix: string) => `${prefix}${HIDDEN_TOKEN}`)
  for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, HIDDEN_TOKEN)
  return out.replace(LONG_RUN, (run) => (looksRandom(run) ? HIDDEN_TOKEN : run))
}
