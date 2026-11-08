import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPTURE_SCHEMA } from './capture-schema'
import {
  type ExecResult,
  ExtractError,
  extract,
  type VisionConfig,
  type VisionRunners,
} from './index'

const config: VisionConfig = {
  routes: ['agy', 'ollama'],
  agyPath: '/opt/agy',
  agyModel: 'model-a',
  ollamaUrl: 'http://ollama.test:11434/',
  ollamaModel: 'model-b',
}

const GOOD = {
  type: 'odometer',
  title: 'Dashboard',
  text: 'TRIP A 44.6',
  summary: 'An odometer.',
  lines: [{ text: 'TRIP A 44.6', struck: false }],
  items: [],
  receipt: null,
  odometer: { odometer: 33396, trip: 44.6, unit: null },
  vehicle: null,
}

function runners(agy: ExecResult | Error, ollama?: { status: number; text: string } | Error) {
  const calls = {
    exec: [] as { argv: string[]; cwd?: string }[],
    post: [] as { url: string; body: unknown }[],
  }
  const fake: VisionRunners = {
    exec: async (argv, options) => {
      calls.exec.push({ argv, cwd: options.cwd })
      if (agy instanceof Error) throw agy
      return agy
    },
    post: async (url, body) => {
      calls.post.push({ url, body })
      if (!ollama || ollama instanceof Error) throw ollama ?? new Error('no ollama')
      return ollama
    },
    read: async () => Buffer.from('pixels'),
  }
  return { fake, calls }
}

const agyOut = (structured: unknown) => ({
  code: 0,
  stdout: JSON.stringify({ status: 'SUCCESS', structured_output: structured }),
  stderr: '',
})
const work = mkdtempSync(join(tmpdir(), 'aico-vision-test-'))
const request = {
  file: join(work, 'capture.jpg'),
  cwd: work,
  schema: CAPTURE_SCHEMA,
  instructions: 'Read it.',
  hint: 'my car',
}

describe('extract', () => {
  it('runs agy with the pinned argv and returns validated JSON', async () => {
    const { fake, calls } = runners(agyOut(GOOD))
    const clock = [1000, 3500]
    const result = await extract(request, config, fake, () => clock.shift() as number)
    expect(result).toMatchObject({ json: GOOD, route: 'agy', ms: 2500 })
    const { argv, cwd } = calls.exec[0] as { argv: string[]; cwd: string }
    expect(cwd).toBe(work)
    expect(argv.slice(0, 1)).toEqual(['/opt/agy'])
    expect(argv.slice(1, 2)).toEqual(['-p'])
    expect(argv[2]).toContain(`${work}/capture.jpg`)
    expect(argv[2]).toContain('my car')
    expect(argv.slice(3, 9)).toEqual([
      '--model',
      'model-a',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(CAPTURE_SCHEMA),
    ])
    expect(argv).not.toContain('--dangerously-skip-permissions')
    expect(argv[9]).toBe('--settings')
    const rules = JSON.parse(readFileSync(argv[10] as string, 'utf8')).permissions
    expect(rules.allow).toEqual([`read_file(${work})`])
    expect(rules.deny).toEqual(
      expect.arrayContaining(['write_file(*)', 'command(*)', 'read_url(*)']),
    )
    expect(rules.deny).toContain('read_file(/etc)')
    expect(rules.deny.some((rule: string) => rule.includes(work))).toBe(false)
    expect(calls.post).toHaveLength(0)
  })

  it('falls back to ollama when agy output does not fit the schema', async () => {
    const { fake, calls } = runners(agyOut({ ...GOOD, type: 'spaceship' }), {
      status: 200,
      text: JSON.stringify({ message: { content: JSON.stringify(GOOD) } }),
    })
    const result = await extract(request, config, fake)
    expect(result.route).toBe('ollama')
    const { url, body } = calls.post[0] as {
      url: string
      body: { messages: { images: string[] }[] }
    }
    expect(url).toBe('http://ollama.test:11434/api/chat')
    expect(body).toMatchObject({
      model: 'model-b',
      stream: false,
      format: CAPTURE_SCHEMA,
      options: { temperature: 0, num_ctx: 16384 },
    })
    expect(body.messages[0]?.images).toEqual([Buffer.from('pixels').toString('base64')])
  })

  it('fails with plain words when every route fails, and never reads audio with ollama', async () => {
    const { fake, calls } = runners(new Error('spawn ENOENT'))
    const error = await extract({ ...request, file: '/work/capture.m4a' }, config, fake).catch(
      (e) => e,
    )
    expect(error).toBeInstanceOf(ExtractError)
    expect(error.message).toMatch(/isn't available/)
    expect(error.message).toMatch(/can't read this kind of file/)
    expect(calls.post).toHaveLength(0)
  })
})
