// vision-extract: one file and a JSON Schema in, validated JSON out.
//
// Routes are tried in the configured order. `agy` (Gemini Flash) is the
// default; a local ollama vision model is the fallback for pictures, and its
// answers are marked `needsCheck`. Output that does not fit the schema is a
// failed route, never a result. There is deliberately no time limit: a route
// ends when its process exits or its connection errors.
//
// The process and HTTP calls are injected (`VisionRunners`) so tests record
// what would have been run and return canned answers.

import { extname } from 'node:path'
import { type JsonSchema, validate } from './validate'

export type { JsonSchema } from './validate'

export type RouteName = 'agy' | 'ollama'

/** Answers from the fallback route are read less well and get a "check this" note. */
export const ROUTE_NEEDS_CHECK: Record<RouteName, boolean> = { agy: false, ollama: true }

export interface VisionConfig {
  /** Routes to try, in order. */
  routes: RouteName[]
  agyPath: string
  agyModel: string
  ollamaUrl: string
  ollamaModel: string
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface VisionRunners {
  /** Runs a program to its end. Rejects when it cannot start. */
  exec(argv: string[], options: { cwd?: string }): Promise<ExecResult>
  /** POSTs JSON; rejects when the connection fails. */
  post(url: string, body: unknown): Promise<{ status: number; text: string }>
  read(path: string): Promise<Buffer>
}

export interface ExtractRequest {
  /** A file path with its real extension (jpg, pdf, m4a...). */
  file: string
  /** Where agy runs; a folder that holds only the file. */
  cwd?: string
  schema: JsonSchema
  /** What to do with the file. */
  instructions: string
  /** Context from the owner (a caption), or none. */
  hint?: string
}

export interface ExtractResult {
  json: unknown
  /** What the route printed, for the log. */
  raw: string
  route: RouteName
  ms: number
}

/** Every route failed. `message` is plain words; `details` is for the server log. */
export class ExtractError extends Error {
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(message)
    this.name = 'ExtractError'
  }
}

class RouteFailure extends Error {
  constructor(
    /** Short plain words, shown to the owner. */
    readonly plain: string,
    /** What really happened, logged. */
    detail: string,
  ) {
    super(detail)
  }
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

function prompt(request: ExtractRequest, withPath: boolean): string {
  const parts = [request.instructions]
  if (request.hint?.trim()) parts.push(`The owner's note about it: ${request.hint.trim()}`)
  if (withPath) parts.push(`The file is at ${request.file}. Open it and read it.`)
  return parts.join('\n\n')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function checked(json: unknown, schema: JsonSchema, route: string): unknown {
  if (json === undefined) throw new RouteFailure('gave no usable answer', `${route}: no JSON`)
  const problem = validate(json, schema)
  if (problem) throw new RouteFailure('gave an answer in the wrong shape', `${route}: ${problem}`)
  return json
}

async function viaAgy(
  request: ExtractRequest,
  config: VisionConfig,
  run: VisionRunners,
): Promise<{ json: unknown; raw: string }> {
  const argv = [
    config.agyPath,
    '-p',
    prompt(request, true),
    '--model',
    config.agyModel,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(request.schema),
    '--dangerously-skip-permissions',
  ]
  let result: ExecResult
  try {
    result = await run.exec(argv, { cwd: request.cwd })
  } catch (error) {
    throw new RouteFailure("isn't available", `agy failed to run: ${(error as Error).message}`)
  }
  if (result.code !== 0)
    throw new RouteFailure(
      'stopped with an error',
      `agy exited ${result.code}: ${result.stderr.trim().slice(-300)}`,
    )
  const outer = parseJson(result.stdout) as
    | { status?: string; structured_output?: unknown; response?: unknown }
    | undefined
  if (!outer || typeof outer !== 'object')
    throw new RouteFailure('gave no usable answer', 'agy printed no JSON')
  if (outer.status !== 'SUCCESS')
    throw new RouteFailure('stopped with an error', `agy status ${String(outer.status)}`)
  const json =
    outer.structured_output ??
    (typeof outer.response === 'string' ? parseJson(outer.response) : undefined)
  return { json: checked(json, request.schema, 'agy'), raw: result.stdout }
}

async function viaOllama(
  request: ExtractRequest,
  config: VisionConfig,
  run: VisionRunners,
): Promise<{ json: unknown; raw: string }> {
  if (!IMAGE_EXTENSIONS.has(extname(request.file).toLowerCase()))
    throw new RouteFailure("can't read this kind of file", 'ollama route reads pictures only')
  const image = (await run.read(request.file)).toString('base64')
  const body = {
    model: config.ollamaModel,
    stream: false,
    format: request.schema,
    options: { temperature: 0, num_ctx: 16384 },
    messages: [{ role: 'user', content: prompt(request, false), images: [image] }],
  }
  let answer: { status: number; text: string }
  try {
    answer = await run.post(`${config.ollamaUrl.replace(/\/+$/, '')}/api/chat`, body)
  } catch (error) {
    throw new RouteFailure("isn't available", `ollama unreachable: ${(error as Error).message}`)
  }
  if (answer.status < 200 || answer.status >= 300)
    throw new RouteFailure('stopped with an error', `ollama HTTP ${answer.status}`)
  const outer = parseJson(answer.text) as { message?: { content?: unknown } } | undefined
  const content = outer?.message?.content
  const json = typeof content === 'string' ? parseJson(content) : undefined
  return { json: checked(json, request.schema, 'ollama'), raw: answer.text }
}

const ROUTES: Record<
  RouteName,
  (
    request: ExtractRequest,
    config: VisionConfig,
    run: VisionRunners,
  ) => Promise<{ json: unknown; raw: string }>
> = { agy: viaAgy, ollama: viaOllama }

const ROUTE_LABEL: Record<RouteName, string> = {
  agy: 'the main reader',
  ollama: 'the local reader',
}

/** Tries each configured route until one gives JSON that fits the schema. */
export async function extract(
  request: ExtractRequest,
  config: VisionConfig,
  run: VisionRunners,
  now: () => number = Date.now,
): Promise<ExtractResult> {
  const plain: string[] = []
  const details: string[] = []
  for (const route of config.routes) {
    const started = now()
    try {
      const { json, raw } = await ROUTES[route](request, config, run)
      return { json, raw, route, ms: now() - started }
    } catch (error) {
      if (!(error instanceof RouteFailure)) throw error
      plain.push(`${ROUTE_LABEL[route]} ${error.plain}`)
      details.push(error.message)
    }
  }
  throw new ExtractError(plain.length ? plain.join('; ') : 'No reader is set up', details)
}
