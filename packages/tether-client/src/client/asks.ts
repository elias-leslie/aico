// The shape rules of an owner ask (docs/api-v1.md "Asks"), kept once for both
// sides: Tether refuses a create or answer past them, and aico-web checks each
// ask Tether sends against the same ones. Lengths count characters (code points),
// except Tether's check of an attach path, which counts UTF-16 units.
// Copies that cannot import this: the asks table's CHECKs (session-engine
// schema.ts) and the notice ask in packages/notify/src/needs-you.ts.

export const ASK_LIMITS = {
  requester: 60,
  question: 200,
  /** How many choices an ask offers. */
  options: 5,
  /** One choice, and the answer text. */
  option: 100,
  body: 4000,
  command: 2000,
  /** The https link an ask opens. */
  open: 300,
  note: 1000,
  /** Files an ask attaches, wants back, or is answered with. */
  files: 20,
  fileHint: 100,
  fileName: 255,
  fileMime: 127,
  path: 4096,
  host: 120,
} as const

/** Who filed an ask when an app did. */
export const ASK_ORIGINS = ['notice', 'status'] as const
export type AskOrigin = (typeof ASK_ORIGINS)[number]
