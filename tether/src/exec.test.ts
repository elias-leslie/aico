import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callSocket } from './client'
import { registerExecRoute } from './exec'
import { HttpError, Router, sendError } from './http'
import { bindPanePolicy, HOST_POLICY, policyLocationIn } from './pane-policy'

const uid = process.getuid?.() ?? 1000
const username = userInfo().username
let dir: string
let socket: string
let server: Server
const originalPolicy = { ...HOST_POLICY }
const GROUP_SCRIPT =
  'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));if(process.argv[2])process.stdout.write("too much output");setInterval(()=>{},1000)'

function policy(refuseUids: number[] = [], attach = { [username]: ['owner-fixture'] }): void {
  writeFileSync(HOST_POLICY.policyFile, JSON.stringify({ refuse_pane_uids: refuseUids, attach }), {
    mode: 0o644,
  })
}

function run(script: string, extra: Record<string, unknown> = {}) {
  return callSocket(socket, 'POST', '/v1/exec', {
    argv: [process.execPath, '-e', script],
    cwd: dir,
    ...extra,
  })
}

function active(pid: number): boolean {
  try {
    // A killed descendant can briefly remain a zombie until init reaps it.
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'
  } catch {
    return false
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-exec-'))
  const etc = join(dir, 'etc')
  const shared = join(dir, 'shared')
  mkdirSync(etc, { mode: 0o755 })
  mkdirSync(join(shared, username), { recursive: true })
  Object.assign(HOST_POLICY, policyLocationIn(etc, shared, uid))
  bindPanePolicy('exec-test')
  policy()
  const router = new Router()
  registerExecRoute(router)
  server = createServer((req, res) => {
    router.dispatch(req, res).catch((error: unknown) => {
      if (!res.destroyed)
        sendError(res, error instanceof HttpError ? error : new HttpError(500, 'test_error'))
    })
  })
  socket = join(dir, 'control.sock')
  await new Promise<void>((resolve) => server.listen(socket, resolve))
})

afterEach(async () => {
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  Object.assign(HOST_POLICY, originalPolicy)
  bindPanePolicy('default')
  rmSync(dir, { recursive: true, force: true })
})

describe('agent execution policy', () => {
  it('runs with the daemon uid and daemon environment in the requested cwd', async () => {
    const result = await run(
      'process.stdout.write(JSON.stringify({uid:process.getuid(),cwd:process.cwd(),home:process.env.HOME,lang:process.env.LANG}))',
      { env: { LANG: 'C' } },
    )
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ uid, returncode: 0, stderr_base64: '' })
    const output = (result.body as { stdout_base64: string }).stdout_base64
    expect(JSON.parse(Buffer.from(output, 'base64').toString())).toEqual({
      uid,
      cwd: dir,
      home: process.env.HOME,
      lang: 'C',
    })
  })

  it('refuses root and refused owners even when rollback permits panes', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    expect(await run('')).toMatchObject({ status: 403, body: { error: 'exec_unavailable' } })
    vi.restoreAllMocks()
    policy([uid])
    writeFileSync(HOST_POLICY.allowFile, 'exec-test\n', { mode: 0o644 })
    expect(await run('')).toMatchObject({ status: 403, body: { error: 'exec_unavailable' } })
  })

  it('refuses absent, invalid and untrusted policy and ordinary private daemons', async () => {
    rmSync(HOST_POLICY.policyFile)
    expect((await run('')).status).toBe(403)
    writeFileSync(HOST_POLICY.policyFile, '{invalid')
    expect((await run('')).status).toBe(403)
    policy([], {})
    expect((await run('')).status).toBe(403)
    policy()
    Object.assign(HOST_POLICY, { trustedUid: uid + 1 })
    expect((await run('')).status).toBe(403)
  })

  it('rejects environment overrides outside the explicit local-operation allowlist', async () => {
    for (const key of [
      'HOME',
      'PATH',
      'SSH_AUTH_SOCK',
      'GITHUB_TOKEN',
      'NODE_OPTIONS',
      'LD_PRELOAD',
    ]) {
      expect(await run('', { env: { [key]: 'caller-value' } })).toMatchObject({
        status: 400,
        body: { error: 'exec_env_denied', field: key },
      })
    }
    const allowed = await run('process.stdout.write(process.env.GIT_CONFIG_VALUE_0)', {
      env: {
        GIT_INDEX_FILE: join(dir, 'index'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 'Local author',
      },
    })
    expect(allowed).toMatchObject({
      status: 200,
      body: { stdout_base64: Buffer.from('Local author').toString('base64') },
    })
  })
})

describe('one-shot execution', () => {
  it('roundtrips binary stdin above the ordinary HTTP limit and returns nonzero normally', async () => {
    const stdin = Buffer.alloc(200_000)
    for (let i = 0; i < stdin.length; i++) stdin[i] = i % 256
    expect(
      await run(
        'process.stdin.pipe(process.stdout);process.stdin.on("end",()=>{process.stderr.write(Buffer.from([0,255,128]));process.exitCode=7})',
        { stdin_base64: stdin.toString('base64') },
      ),
    ).toMatchObject({
      status: 200,
      body: {
        uid,
        returncode: 7,
        stdout_base64: stdin.toString('base64'),
        stderr_base64: Buffer.from([0, 255, 128]).toString('base64'),
      },
    })
  })

  it('does not invoke a shell and handles a child closing stdin early', async () => {
    const literal = '$(touch should-not-exist); echo hello'
    expect(
      await run('', {
        argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal],
        stdin_base64: Buffer.alloc(2 * 1024 * 1024, 255).toString('base64'),
      }),
    ).toMatchObject({
      status: 200,
      body: { returncode: 0, stdout_base64: Buffer.from(literal).toString('base64') },
    })
    expect(existsSync(join(dir, 'should-not-exist'))).toBe(false)
  })

  it('reports spawn failure without command contents and represents signal exits', async () => {
    expect(await run('', { argv: [join(dir, 'does-not-exist'), 'private-argument'] })).toEqual({
      status: 502,
      body: { error: 'exec_spawn_failed' },
    })
    expect(await run('process.kill(process.pid,"SIGTERM")')).toMatchObject({
      status: 200,
      body: { returncode: -15 },
    })
  })

  it('validates argv, cwd, binary encoding, environment and resource bounds', async () => {
    for (const extra of [
      { argv: [] },
      { argv: [''] },
      { argv: ['node', 1] },
      { argv: ['node', '\0'] },
      { cwd: 'relative' },
      { stdin_base64: '!not-base64!' },
      { stdin_base64: null },
      { stdin_base64: 'Zh==' },
      { env: { LANG: 4 } },
      { timeout_ms: 0 },
      { timeout_ms: 3_600_001 },
      { max_output_bytes: 0 },
      { max_output_bytes: 128 * 1024 * 1024 + 1 },
      { shell: true },
    ])
      expect((await run('', extra)).status).toBe(400)
  })

  it('enforces the combined stdout and stderr bound', async () => {
    expect(
      await run('process.stdout.write("123456");process.stderr.write("abcdef")', {
        max_output_bytes: 10,
      }),
    ).toEqual({ status: 413, body: { error: 'exec_output_limit' } })
    expect(await run('process.stdout.write("1234567890")', { max_output_bytes: 10 })).toMatchObject(
      {
        status: 200,
        body: { returncode: 0 },
      },
    )
  })

  it('kills only its owned process group on timeout, including descendants', async () => {
    const marker = join(dir, 'pids')
    const result = await run(GROUP_SCRIPT, {
      argv: [process.execPath, '-e', GROUP_SCRIPT, marker],
      timeout_ms: 1_000,
    })
    expect(result).toEqual({ status: 408, body: { error: 'exec_timeout' } })
    const pids = JSON.parse(readFileSync(marker, 'utf8')) as number[]
    await expect.poll(() => pids.every((pid) => !active(pid))).toBe(true)
    expect((await run('')).status).toBe(200)
  })

  it('cleans up descendants holding output pipes when the direct child exits', async () => {
    const marker = join(dir, 'exited-pids')
    const script =
      'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2]});const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));fs.writeSync(1,"finished");process.exit(0)'
    const result = await run(script, {
      argv: [process.execPath, '-e', script, marker],
      timeout_ms: 1_000,
    })
    expect(result).toMatchObject({
      status: 200,
      body: { returncode: 0, stdout_base64: Buffer.from('finished').toString('base64') },
    })
    const pids = JSON.parse(readFileSync(marker, 'utf8')) as number[]
    await expect.poll(() => pids.every((pid) => !active(pid))).toBe(true)
    expect((await run('')).status).toBe(200)
  })

  it('kills the owned group when output exceeds the bound', async () => {
    const marker = join(dir, 'output-pids')
    const result = await run(GROUP_SCRIPT, {
      argv: [process.execPath, '-e', GROUP_SCRIPT, marker, 'output'],
      max_output_bytes: 1,
    })
    expect(result).toEqual({ status: 413, body: { error: 'exec_output_limit' } })
    const pids = JSON.parse(readFileSync(marker, 'utf8')) as number[]
    await expect.poll(() => pids.every((pid) => !active(pid))).toBe(true)
    expect((await run('')).status).toBe(200)
  })

  it('cancels the owned group when the client disconnects', async () => {
    const marker = join(dir, 'disconnected-pids')
    const req = request({
      socketPath: socket,
      method: 'POST',
      path: '/v1/exec',
      headers: { 'content-type': 'application/json' },
    })
    req.on('error', () => {})
    req.end(
      JSON.stringify({
        argv: [process.execPath, '-e', GROUP_SCRIPT, marker],
        cwd: dir,
      }),
    )
    await expect.poll(() => existsSync(marker)).toBe(true)
    const pids = JSON.parse(readFileSync(marker, 'utf8')) as number[]
    req.destroy()
    await expect.poll(() => pids.every((pid) => !active(pid))).toBe(true)
    expect((await run('')).status).toBe(200)
  })
})
