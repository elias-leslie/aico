// One generateContent call to the Gemini API. The key comes from the environment variable or a
// stored Aico login; it is never printed, logged or written, and API errors carry only Google's message.
import { request } from 'node:https'
import { LoginStore } from '@aico/fleet/logins'
import { loginCaller } from '@aico/fleet/logins-cli'
import { config } from './config'

export interface Part {
  text?: string
  file_data?: { file_uri: string }
  video_metadata?: { start_offset: string; end_offset?: string }
}
export interface Usage {
  prompt: number
  output: number
  thoughts: number
}
export interface Generated {
  text: string
  model: string
  usage: Usage
  /** Which key answered: an environment variable or a login name, never the key. */
  key: string
}
/** `kind` tells the caller what to say: no key at all, the video itself refused, or any other failure. */
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly kind: 'no-key' | 'api' | 'network' | 'empty',
    readonly status = 0,
  ) {
    super(message)
  }
}

export type Post = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; text: string }>

/** No timeout of its own: a video review can legitimately stay silent for minutes. */
const post: Post = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })

interface Key {
  name: string
  value: string
}
/** The key named by the environment variable first, then each configured login the caller may use. */
function* keys(env: NodeJS.ProcessEnv, store?: () => LoginStore): Generator<Key> {
  const direct = env[config.gemini.keyEnv]?.trim()
  if (direct) yield { name: `$${config.gemini.keyEnv}`, value: direct }
  let logins: LoginStore | undefined
  for (const name of config.gemini.loginNames) {
    try {
      logins ??= store ? store() : new LoginStore(env)
      const value = logins.value(name, loginCaller(env)).toString().trim()
      if (value) yield { name, value }
    } catch {
      // Not stored on this machine or not granted to this caller: the next one may be.
    }
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const RETRY_WITH_NEXT_KEY = new Set([401, 403, 429])

export async function generate(
  model: string,
  parts: Part[],
  options: {
    resolution?: string
    env: NodeJS.ProcessEnv
    post?: Post
    store?: () => LoginStore
    sleep?: (ms: number) => Promise<void>
  },
): Promise<Generated> {
  const send = options.post ?? post
  const body = JSON.stringify({
    contents: [{ parts }],
    ...(options.resolution ? { generationConfig: { mediaResolution: options.resolution } } : {}),
  })
  const url = `${config.gemini.endpoint}/models/${encodeURIComponent(model)}:generateContent`
  let last: GeminiError | null = null
  for (const key of keys(options.env, options.store)) {
    let answer: { status: number; text: string }
    for (let attempt = 0; ; attempt++) {
      try {
        answer = await send(
          url,
          { 'x-goog-api-key': key.value, 'content-type': 'application/json' },
          body,
        )
      } catch (error) {
        throw new GeminiError(`Gemini connection failed: ${(error as Error).message}`, 'network')
      }
      const wait = config.gemini.retry.waitSeconds[attempt]
      if (wait === undefined || !config.gemini.retry.statuses.includes(answer.status)) break
      await (options.sleep ?? sleep)(wait * 1000)
    }
    let data: any
    try {
      data = JSON.parse(answer.text)
    } catch {
      data = null
    }
    if (answer.status !== 200) {
      const message = String(data?.error?.message ?? answer.text)
        .replaceAll(key.value, '***')
        .split('\n')[0]
        .slice(0, 240)
      last = new GeminiError(
        `Gemini ${answer.status} (${key.name}): ${message}`,
        'api',
        answer.status,
      )
      if (RETRY_WITH_NEXT_KEY.has(answer.status)) continue
      throw last
    }
    const text = ((data?.candidates?.[0]?.content?.parts ?? []) as { text?: string }[])
      .map((p) => p.text ?? '')
      .join('')
      .trim()
    if (!text) {
      const why =
        data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? 'no text'
      throw new GeminiError(`Gemini returned no text (${why})`, 'empty')
    }
    const u = data.usageMetadata ?? {}
    return {
      text,
      model: data.modelVersion ?? model,
      usage: {
        prompt: u.promptTokenCount ?? 0,
        output: u.candidatesTokenCount ?? 0,
        thoughts: u.thoughtsTokenCount ?? 0,
      },
      key: key.name,
    }
  }
  throw (
    last ??
    new GeminiError(
      `no Gemini key: set ${config.gemini.keyEnv} or store one of ${config.gemini.loginNames.join(', ')} with aico logins`,
      'no-key',
    )
  )
}
