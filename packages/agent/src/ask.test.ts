// `aico prompt-model`: the rules (deny rows, provider allowlist, Claude only as claude -p with no API
// key), the schema check, the files refusal, wire silence, and the typed failures, with fake
// claude and agy commands and pi-ai's faux provider. Nothing here calls a real model.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog, type LaunchPolicy } from '@aico/context'
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Models,
} from '@earendil-works/pi-ai'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { ask, askMain, fileBlocks } from './ask'
import policyData from './fixtures/policy.json' with { type: 'json' }
import { HARNESS } from './rules'
import { jsonIn } from './schema'

const policy = policyData as unknown as LaunchPolicy
const context = { policy, projects: [] }
const dir = mkdtempSync(join(tmpdir(), 'aico-ask-test-'))
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'integer' } },
  required: ['answer'],
  additionalProperties: false,
}

/** A command that prints `body` (a shell snippet) and records its arguments and whether an API key reached it. */
function fakeBin(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${path}.args"\nprintf '%s' "\${ANTHROPIC_API_KEY:-unset}" > "${path}.key"\ncat > "${path}.stdin"\n${body}\n`,
  )
  chmodSync(path, 0o755)
  return path
}

const claudeResult = (extra: Record<string, unknown>) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    usage: { input_tokens: 5, output_tokens: 2 },
    modelUsage: { 'claude-haiku-5-5': {} },
    ...extra,
  })
const agyResult = (extra: Record<string, unknown>) =>
  JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'ok',
      usage: { input_tokens: 5, output_tokens: 2 },
      ...extra,
    },
  })
const echoing = (json: string) => `cat <<'EOF'\n${json}\nEOF`

const request = (model: string, extra = {}) => ({
  model,
  question: 'six times seven?',
  cwd: dir,
  ...extra,
})
const kind = (result: Awaited<ReturnType<typeof ask>>) => result.outcome.kind

it('reads JSON in a fenced reply', () => {
  expect(jsonIn('Sure:\n```json\n{"answer": 42}\n```')).toEqual({ value: { answer: 42 } })
  expect(jsonIn('the answer is 42')).toBeNull()
})

describe('rules', () => {
  const bins = { claude: fakeBin('claude-rules', echoing(claudeResult({}))) }

  it.each(['recon', 'hunting'])(
    'refuses an unverifiable native CLI transport for %s before starting it',
    async (role) => {
      const agy = fakeBin(`agy-egress-${role}`, echoing(agyResult({})))
      const result = await ask(request('gemini-3.8-flash', { role }), { context, bins: { agy } })
      expect(result.outcome).toMatchObject({ kind: 'refused', reason: 'egress_denied' })
      expect(existsSync(`${agy}.args`)).toBe(false)
    },
  )

  it('refuses a role whose egress profile is undefined', async () => {
    const harness = structuredClone(HARNESS)
    harness.roles.lookup.egress = 'missing-profile'
    expect((await ask(request('haiku'), { context, bins, harness })).outcome).toMatchObject({
      kind: 'refused',
      reason: 'unenforceable',
    })
  })

  it('refuses an unknown model, an unknown role and a model the role denies, before anything runs', async () => {
    expect((await ask(request('no-such-model'), { context, bins })).outcome).toMatchObject({
      kind: 'refused',
      reason: 'model_unknown',
    })
    expect(
      (await ask(request('haiku', { role: 'nope' }), { context, bins })).outcome,
    ).toMatchObject({
      kind: 'refused',
      reason: 'unknown_role',
    })
    expect(
      (await ask(request('haiku', { role: 'hunting' }), { context, bins })).outcome,
    ).toMatchObject({
      kind: 'refused',
      reason: 'model_denied',
    })
  })

  it('refuses providers aico prompt-model does not run', async () => {
    expect((await ask(request('grok'), { context, bins })).outcome).toMatchObject({
      kind: 'refused',
      reason: 'provider_not_allowed',
    })
  })

  it('refuses a pi-ai model that speaks the Anthropic API', async () => {
    const provider = fauxProvider({
      provider: 'openai',
      api: 'anthropic-messages',
      models: [{ id: 'gpt-6.1-sol', reasoning: true }],
    })
    const models = createModels()
    models.setProvider(provider.provider)
    const result = await ask(request('codex'), { context, models })
    expect(result.outcome).toMatchObject({ kind: 'refused', reason: 'provider_not_allowed' })
  })

  it('has no Anthropic factory to register', () => {
    expect(Object.keys(HARNESS.providers)).not.toContain('claude')
    expect(HARNESS.ask.via.claude.run).toBe('claude')
  })
})

describe('claude -p', () => {
  it.each([
    { type: 'string', pattern: '[' },
    { type: 'array', minItems: 'x' },
    { type: 'string', unknownKeyword: true },
  ])('returns typed bad_input for invalid schemas without starting a model', async (schema) => {
    const claude = fakeBin('claude-schema-preflight', echoing(claudeResult({ result: 'text' })))
    const result = await ask(request('haiku', { schema }), { context, bins: { claude } })
    expect(result.outcome).toMatchObject({
      kind: 'bad_input',
      detail: expect.stringContaining('invalid schema'),
    })
    expect(existsSync(`${claude}.args`)).toBe(false)
  })
  it('runs with tools off, no API key in its environment, the prompt on stdin, and returns the answer', async () => {
    const claude = fakeBin('claude-ok', echoing(claudeResult({ result: '42' })))
    const saved = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-key'
    try {
      const result = await ask(request('haiku'), { context, bins: { claude } })
      expect(result.outcome).toMatchObject({ kind: 'done', model: 'claude-haiku-5-5', text: '42' })
      expect(result.tokens).toEqual({ input: 5, output: 2 })
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
    expect(readFileSync(`${claude}.key`, 'utf8')).toBe('unset')
    const args = readFileSync(`${claude}.args`, 'utf8').split('\n')
    expect(args).toContain('-p')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(readFileSync(`${claude}.stdin`, 'utf8')).toContain('six times seven?')
  })

  it('passes the schema and checks the answer against it', async () => {
    const good = fakeBin(
      'claude-good',
      echoing(claudeResult({ result: '{"answer":42}', structured_output: { answer: 42 } })),
    )
    const done = await ask(request('haiku', { schema: SCHEMA }), {
      context,
      bins: { claude: good },
    })
    expect(done.outcome).toMatchObject({
      kind: 'done',
      data: { answer: 42 },
      text: '{"answer":42}',
    })
    expect(readFileSync(`${good}.args`, 'utf8')).toContain('--json-schema')

    const wrong = fakeBin(
      'claude-wrong',
      echoing(claudeResult({ structured_output: { answer: 'x' } })),
    )
    const bad = await ask(request('haiku', { schema: SCHEMA }), {
      context,
      bins: { claude: wrong },
    })
    expect(bad.outcome).toMatchObject({
      kind: 'schema_invalid',
      errors: [expect.stringContaining('must be integer')],
    })
  })

  it('types a refusal, a model swap, an error result and a missing command', async () => {
    const run = (json: string) =>
      ask(request('haiku'), { context, bins: { claude: fakeBin('claude-x', echoing(json)) } })
    expect((await run(claudeResult({ stop_reason: 'refusal' }))).outcome.kind).toBe('model_refused')
    expect(
      (await run(claudeResult({ modelUsage: { 'claude-opus-5-5': {} } }))).outcome,
    ).toMatchObject({
      kind: 'model_swap',
      served: 'claude-opus-5-5',
    })
    expect(
      (await run(claudeResult({ is_error: true, result: 'overloaded' }))).outcome,
    ).toMatchObject({
      kind: 'error',
      detail: expect.stringContaining('overloaded'),
    })
    const gone = await ask(request('haiku'), { context, bins: { claude: join(dir, 'not-there') } })
    expect(gone.outcome).toMatchObject({
      kind: 'error',
      detail: 'the claude command is not installed',
    })
  })

  it('stops after the wire silence bound and no sooner', async () => {
    const claude = fakeBin('claude-silent', 'sleep 5')
    const started = Date.now()
    const result = await ask(request('haiku'), { context, bins: { claude }, silenceMs: 300 })
    expect(result.outcome).toMatchObject({ kind: 'silent', model: 'claude-haiku-5-5' })
    expect(Date.now() - started).toBeLessThan(4_500)
    // Output arriving inside the bound keeps the call alive past it.
    const chatty = fakeBin(
      'claude-chatty',
      `for i in 1 2 3 4; do echo '{"type":"system"}'; sleep 0.2; done\n${echoing(claudeResult({ result: 'late' }))}`,
    )
    const alive = await ask(request('haiku'), { context, bins: { claude: chatty }, silenceMs: 500 })
    expect(alive.outcome).toMatchObject({ kind: 'done', text: 'late' })
  })
})

describe('agy', () => {
  it('refuses a prompt too big for one argument instead of calling agy "not installed"', async () => {
    const agy = fakeBin('agy-big', echoing(agyResult({})))
    const huge = { question: 'x'.repeat(200 * 1024) }
    const result = await ask(request('gemini-3.8-flash', huge), { context, bins: { agy } })
    expect(result.outcome).toMatchObject({ kind: 'bad_input', too_big: true })
    expect(JSON.stringify(result.outcome)).not.toContain('not installed')
    expect(existsSync(`${agy}.args`)).toBe(false)
  })

  it('keeps structured output by not naming an agent when there is a schema, still denying the tools', async () => {
    const agy = fakeBin('agy-schema', echoing(agyResult({ structured_output: { answer: 1 } })))
    await ask(request('gemini-3.8-flash', { schema: SCHEMA }), { context, bins: { agy } })
    const args = readFileSync(`${agy}.args`, 'utf8').split('\n')
    expect(args).not.toContain('--agent')
    const { deny } = JSON.parse(args[args.indexOf('--settings') + 1] as string).permissions
    expect(deny).toEqual(expect.arrayContaining(['read_file(*)', 'write_file(*)', 'command(*)']))
  })

  it('runs with every tool off and an agent with none, in a folder of its own', async () => {
    const agy = fakeBin(
      'agy-locked',
      `cat .agents/agents/aico-answer.md > "${dir}/agent.md"\n${echoing(agyResult({}))}`,
    )
    const result = await ask(request('gemini-3.8-flash'), { context, bins: { agy } })
    expect(result.outcome).toMatchObject({ kind: 'done' })
    const args = readFileSync(`${agy}.args`, 'utf8').split('\n')
    expect(args[args.indexOf('--agent') + 1]).toBe('aico-answer')
    expect(args).toContain('--disable-slash-commands')
    expect(args).not.toContain('--dangerously-skip-permissions')
    const { deny } = JSON.parse(args[args.indexOf('--settings') + 1] as string).permissions
    expect(deny).toEqual(
      expect.arrayContaining(['read_file(*)', 'write_file(*)', 'command(*)', 'read_url(*)']),
    )
    expect(readFileSync(`${dir}/agent.md`, 'utf8')).toContain('tools: []')
  })

  it('says why when agy reports an error, as when it is signed out', async () => {
    const agy = fakeBin(
      'agy-out',
      `${echoing(agyResult({ status: 'ERROR', response: '', error: 'authentication failed or timed out' }))}\nexit 1`,
    )
    const result = await ask(request('gemini-3.8-flash'), { context, bins: { agy } })
    expect(result.outcome).toMatchObject({
      kind: 'error',
      detail: expect.stringContaining('authentication failed'),
    })
  })

  it('takes an empty answer as a failure, not as done', async () => {
    const agy = fakeBin('agy-empty', echoing(agyResult({ response: '  ' })))
    const result = await ask(request('gemini-3.8-flash'), { context, bins: { agy } })
    expect(result.outcome).toMatchObject({ kind: 'error' })
  })

  it('still reports a missing agy command as not installed', async () => {
    const result = await ask(request('gemini-3.8-flash'), {
      context,
      bins: { agy: join(dir, 'no-such-agy') },
    })
    expect(JSON.stringify(result.outcome)).toContain('not installed')
  })

  it('returns the answer and its schema-checked data', async () => {
    const agy = fakeBin(
      'agy-ok',
      echoing(agyResult({ response: 'x', structured_output: { answer: 42 } })),
    )
    const result = await ask(request('gemini-3.8-flash', { schema: SCHEMA, effort: 'low' }), {
      context,
      bins: { agy },
    })
    expect(result.outcome).toMatchObject({
      kind: 'done',
      model: 'gemini-3.8-flash',
      data: { answer: 42 },
    })
    const args = readFileSync(`${agy}.args`, 'utf8').split('\n')
    expect(args[args.indexOf('--effort') + 1]).toBe('low')
    expect(args).toContain('--json-schema')
  })

  it('types an answer that needed a tool as tool_denied', async () => {
    const agy = fakeBin(
      'agy-denied',
      echoing(
        agyResult({
          response: '',
          denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
        }),
      ),
    )
    const result = await ask(request('gemini-3.8-flash'), { context, bins: { agy } })
    expect(result.outcome).toMatchObject({
      kind: 'tool_denied',
      detail: expect.stringContaining('RunCommand'),
    })
  })
})

describe('pi-ai models', () => {
  function faux() {
    const provider = fauxProvider({
      provider: 'openai',
      api: 'faux-openai',
      models: [{ id: 'gpt-6.1-sol', reasoning: true }],
    })
    const models = createModels()
    models.setProvider(provider.provider)
    return { provider, models }
  }

  it('sends inline document images to the model instead of dropping them', async () => {
    const { provider, models } = faux()
    const stream = vi.spyOn(provider.provider, 'streamSimple')
    provider.setResponses([fauxAssistantMessage('read')])
    const image = { data: 'eA==', mimeType: 'image/png' }
    expect(kind(await ask(request('codex', { images: [image] }), { context, models }))).toBe('done')
    expect(
      stream.mock.calls[0]?.[1]?.messages.find((message) => message.role === 'user')?.content,
    ).toContainEqual({
      type: 'image',
      ...image,
    })
    stream.mockRestore()
  })

  it('identifies each OpenCode Go question with a session header', async () => {
    const provider = fauxProvider({
      provider: 'opencode-go',
      api: 'faux-go',
      models: [{ id: 'deepseek-v4.1-flash', reasoning: true }],
    })
    const models = createModels()
    models.setProvider(provider.provider)
    const stream = vi.spyOn(provider.provider, 'streamSimple')
    provider.setResponses([fauxAssistantMessage('ok')])
    expect(kind(await ask(request('opencode-go/deepseek-v4.1-flash'), { context, models }))).toBe(
      'done',
    )
    const headers = stream.mock.calls[0]?.[2]?.headers
    expect(headers?.['x-opencode-session']).toMatch(/^[a-f0-9-]{36}$/)
    expect(headers?.['User-Agent']).toBe('aico-agent/0.1.0')
    stream.mockRestore()
  })

  it.each([
    ['https://outside.example/v1', 'refused', 0],
    ['https://api.openai.com/v1', 'done', 1],
  ] as const)(
    'checks the resolved endpoint %s against recon egress',
    async (baseUrl, expected, calls) => {
      const { provider, models } = faux()
      provider.setResponses([fauxAssistantMessage('inside')])
      const getModel = models.getModel.bind(models)
      vi.spyOn(models, 'getModel').mockImplementation((p, id) => {
        const model = getModel(p, id)
        return model ? { ...model, baseUrl } : model
      })
      const result = await ask(request('codex', { role: 'recon' }), { context, models })
      expect(result.outcome.kind).toBe(expected)
      if (expected === 'refused') expect(result.outcome).toMatchObject({ reason: 'egress_denied' })
      expect(provider.state.callCount).toBe(calls)
    },
  )

  it('answers with the schema instruction in the system prompt and reads fenced JSON', async () => {
    const { provider, models } = faux()
    provider.setResponses([fauxAssistantMessage('```json\n{"answer": 42}\n```')])
    const result = await ask(request('codex', { schema: SCHEMA }), { context, models })
    expect(result.outcome).toMatchObject({
      kind: 'done',
      model: 'codex/gpt-6.1-sol',
      data: { answer: 42 },
    })
  })

  it('fails the schema check on an answer that is not JSON', async () => {
    const { provider, models } = faux()
    provider.setResponses([fauxAssistantMessage('forty-two')])
    const result = await ask(request('codex', { schema: SCHEMA }), { context, models })
    expect(result.outcome).toMatchObject({
      kind: 'schema_invalid',
      errors: ['the answer is not JSON'],
    })
  })

  it('types a provider refusal', async () => {
    const { provider, models } = faux()
    provider.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'cyber_policy: blocked' }),
    ])
    expect(kind(await ask(request('codex'), { context, models }))).toBe('model_refused')
  })

  it('aborts a stream with no event inside the silence bound', async () => {
    const models = {
      getModel: () => ({ api: 'faux', reasoning: true, id: 'gpt-6.1-sol' }),
      streamSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
        const stream = createAssistantMessageEventStream()
        options.signal.addEventListener('abort', () =>
          stream.end(fauxAssistantMessage('', { stopReason: 'aborted' })),
        )
        return stream
      },
    } as unknown as Models
    const started = Date.now()
    const result = await ask(request('codex'), { context, models, silenceMs: 300 })
    expect(result.outcome).toMatchObject({ kind: 'silent', model: 'codex/gpt-6.1-sol' })
    expect(Date.now() - started).toBeLessThan(4_500)
  })
})

describe('local receipt images', () => {
  it('keeps the image on the local Ollama route and checks the structured answer', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          `${JSON.stringify({ message: { content: '{"answer":42}' } })}\n${JSON.stringify({ done: true, model: 'qwen3-vl:8b-instruct', prompt_eval_count: 7, eval_count: 3 })}\n`,
        ),
      )
    try {
      const result = await ask(
        request('local/qwen-vl', {
          schema: SCHEMA,
          images: [{ data: 'eA==', mimeType: 'image/jpeg' }],
        }),
        { context },
        { AICO_OLLAMA_URL: 'http://127.0.0.1:11434' },
      )
      expect(result.outcome).toMatchObject({
        kind: 'done',
        model: 'local/qwen3-vl:8b-instruct',
        data: { answer: 42 },
      })
      expect(result.tokens).toEqual({ input: 7, output: 3 })
      expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://127.0.0.1:11434/api/chat')
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
        model: 'qwen3-vl:8b-instruct',
        format: SCHEMA,
        messages: [{ role: 'system' }, { role: 'user', images: ['eA=='] }],
      })
    } finally {
      fetcher.mockRestore()
    }
  })

  it('refuses a local endpoint outside a contained role before making the request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
    try {
      const result = await ask(request('local/qwen-vl', { role: 'recon' }), { context })
      expect(result.outcome).toMatchObject({ kind: 'refused', reason: 'egress_denied' })
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })

  it('rejects malformed and oversized images before touching a provider', async () => {
    for (const images of [
      null,
      [{ data: 'not base64', mimeType: 'image/png' }],
      [{ data: 'eA==', mimeType: 'text/html' }],
    ])
      expect(kind(await ask(request('codex', { images }), { context }))).toBe('bad_input')
    const harness = structuredClone(HARNESS)
    harness.ask.max_image_bytes = 1
    expect(
      kind(
        await ask(request('codex', { images: [{ data: 'eHg=', mimeType: 'image/png' }] }), {
          context,
          harness,
        }),
      ),
    ).toBe('bad_input')
  })
})

describe('files', () => {
  const harness = HARNESS
  it('refuses env files, key files and credential paths, even when they do not exist', () => {
    const env = join(dir, '.env')
    writeFileSync(env, 'KEY=value\n')
    expect(fileBlocks([env], dir, harness)).toEqual({
      error: `${env}: a credential or key file is never sent to a model`,
    })
    const auth = join(getAgentDir(), 'auth.json')
    expect(fileBlocks([auth], dir, harness)).toMatchObject({
      error: expect.stringContaining('credential'),
    })
    const claude = join(homedir(), '.claude', '.credentials.json')
    expect(fileBlocks([claude], dir, harness)).toMatchObject({
      error: expect.stringContaining('credential'),
    })
  })

  it('refuses a missing file, a binary file and a directory, and wraps text files', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'hello\n')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 0, 2]))
    expect(fileBlocks(['absent.txt'], dir, harness)).toEqual({ error: 'absent.txt: no such file' })
    expect(fileBlocks(['bin.dat'], dir, harness)).toEqual({ error: 'bin.dat: not a text file' })
    expect(fileBlocks(['sub'], dir, harness)).toEqual({ error: 'sub: not a file' })
    expect(fileBlocks(['notes.txt'], dir, harness)).toEqual({
      text: '<file path="notes.txt">\nhello\n\n</file>',
    })
  })

  it('puts the file text in front of the question and refuses before any model runs', async () => {
    writeFileSync(join(dir, 'ctx.txt'), 'the sky is green')
    const claude = fakeBin('claude-files', echoing(claudeResult({})))
    await ask(request('haiku', { files: ['ctx.txt'] }), { context, bins: { claude } })
    expect(readFileSync(`${claude}.stdin`, 'utf8')).toMatch(
      /the sky is green[\s\S]*six times seven\?/,
    )
    const bad = await ask(request('haiku', { files: [join(dir, '.env')] }), {
      context,
      bins: { claude: join(dir, 'never-run') },
    })
    expect(bad.outcome.kind).toBe('bad_input')
  })
})

describe('askMain', () => {
  const quiet = async (argv: string[], extra = {}) => {
    const write = process.stderr.write.bind(process.stderr)
    const out = process.stdout.write.bind(process.stdout)
    const seen: string[] = []
    process.stderr.write = (chunk: string | Uint8Array) => {
      seen.push(String(chunk))
      return true
    }
    process.stdout.write = (chunk: string | Uint8Array) => {
      seen.push(String(chunk))
      return true
    }
    try {
      return {
        code: await askMain(argv, process.env, { context, cwd: dir, ...extra }),
        seen: seen.join(''),
      }
    } finally {
      process.stderr.write = write
      process.stdout.write = out
    }
  }

  it('prints its help on stdout under its own name, exit 0', async () => {
    const write = process.stdout.write.bind(process.stdout)
    const out: string[] = []
    process.stdout.write = (chunk: string | Uint8Array) => {
      out.push(String(chunk))
      return true
    }
    try {
      expect(await askMain(['--help'])).toBe(0)
      expect(await askMain(['-h'])).toBe(0)
    } finally {
      process.stdout.write = write
    }
    expect(out.join('')).toMatch(/^Usage: aico prompt-model MODEL "question"/)
  })

  it('exits 2 on usage mistakes, 0 on an answer and the typed code on a failure', async () => {
    expect((await quiet([])).code).toBe(2)
    expect((await quiet(['haiku'])).code).toBe(2)
    expect((await quiet(['haiku'])).seen).toMatch(/^aico prompt-model: the question is missing/)
    expect((await quiet([])).seen).toMatch(/^aico prompt-model: the model and the question/)
    expect((await quiet(['haiku', 'q', '--schema', 'missing.json'])).code).toBe(2)
    expect((await quiet(['no-such-model', 'q'])).code).toBe(3)
    const claude = fakeBin('claude-main', echoing(claudeResult({ result: '42' })))
    const ok = await quiet(['haiku', 'six times seven?'], { bins: { claude } })
    expect(ok.code).toBe(0)
    expect(ok.seen).toContain('42\n')
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(SCHEMA))
    const wrong = fakeBin(
      'claude-main2',
      echoing(claudeResult({ structured_output: { answer: 'x' } })),
    )
    expect(
      (await quiet(['haiku', 'q', '--schema', 'schema.json'], { bins: { claude: wrong } })).code,
    ).toBe(5)
  })

  it('takes --files up to the next option and the question from stdin', async () => {
    writeFileSync(join(dir, 'a.txt'), 'AAA')
    writeFileSync(join(dir, 'b.txt'), 'BBB')
    const claude = fakeBin('claude-argv', echoing(claudeResult({})))
    const result = await quiet(['haiku', '-', '--files', 'a.txt', 'b.txt'], {
      bins: { claude },
      stdin: async () => 'from stdin\n',
    })
    expect(result.code).toBe(0)
    expect(readFileSync(`${claude}.stdin`, 'utf8')).toMatch(/AAA[\s\S]*BBB[\s\S]*from stdin/)
  })
})

void Catalog
