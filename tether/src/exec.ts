import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { constants } from 'node:os'
import { isAbsolute } from 'node:path'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import { currentPaneRefusal, detectSharedMode, readPanePolicy } from './pane-policy'

const MIB = 1024 * 1024
const MAX_STDIN_BYTES = 32 * MIB
const MAX_EXEC_BODY_BYTES = Math.ceil(MAX_STDIN_BYTES / 3) * 4 + MIB
const ENV_KEYS = new Set([
  'GIT_INDEX_FILE',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_COUNT',
  'GIT_OPTIONAL_LOCKS',
  'GIT_NO_LAZY_FETCH',
  'GIT_TERMINAL_PROMPT',
  'LC_ALL',
  'LANG',
  'TZ',
])
const FIELDS = new Set(['argv', 'cwd', 'stdin_base64', 'env', 'timeout_ms', 'max_output_bytes'])

interface ExecRequest {
  argv: [string, ...string[]]
  cwd: string
  stdin: Buffer
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
}

function invalid(field: string): never {
  throw new HttpError(400, 'invalid_body', { field })
}

function bounded(value: unknown, fallback: number, max: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    invalid(field)
  return value
}

function parseExec(body: Record<string, unknown>): ExecRequest {
  if (Object.keys(body).some((key) => !FIELDS.has(key))) invalid('fields')
  if (
    !Array.isArray(body.argv) ||
    body.argv.length === 0 ||
    !body.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0')) ||
    !body.argv[0]
  )
    invalid('argv')
  if (typeof body.cwd !== 'string' || !isAbsolute(body.cwd) || body.cwd.includes('\0'))
    invalid('cwd')
  const env = { ...process.env }
  if (body.env !== undefined) {
    if (body.env === null || typeof body.env !== 'object' || Array.isArray(body.env)) invalid('env')
    for (const [key, value] of Object.entries(body.env)) {
      if (!ENV_KEYS.has(key) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key))
        throw new HttpError(400, 'exec_env_denied', { field: key })
      if (typeof value !== 'string' || value.includes('\0')) invalid('env')
      env[key] = value
    }
  }
  const encoded = body.stdin_base64 === undefined ? '' : body.stdin_base64
  if (typeof encoded !== 'string') invalid('stdin_base64')
  if (encoded.length > Math.ceil(MAX_STDIN_BYTES / 3) * 4)
    throw new HttpError(413, 'exec_stdin_limit')
  const stdin = Buffer.from(encoded, 'base64')
  if (stdin.length > MAX_STDIN_BYTES) throw new HttpError(413, 'exec_stdin_limit')
  if (stdin.toString('base64') !== encoded) invalid('stdin_base64')
  return {
    argv: body.argv as [string, ...string[]],
    cwd: body.cwd,
    stdin,
    env,
    timeoutMs: bounded(body.timeout_ms, 60_000, 3_600_000, 'timeout_ms'),
    maxOutputBytes: bounded(body.max_output_bytes, 32 * MIB, 128 * MIB, 'max_output_bytes'),
  }
}

/** No root, refused owner (even during rollback), or ordinary private daemon. */
function executionUid(): number {
  const uid = process.getuid?.()
  const policy = readPanePolicy()
  if (
    uid === undefined ||
    uid === 0 ||
    policy.state !== 'ok' ||
    policy.refuseUids.includes(uid) ||
    currentPaneRefusal() ||
    !detectSharedMode(uid)
  )
    throw new HttpError(403, 'exec_unavailable')
  return uid
}

async function execute(
  input: ExecRequest,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<{ returncode: number; stdout_base64: string; stderr_base64: string }> {
  if (request.aborted || response.destroyed) throw new HttpError(499, 'exec_client_disconnected')
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(input.argv[0], input.argv.slice(1), {
        cwd: input.cwd,
        env: input.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      })
    } catch {
      reject(new HttpError(502, 'exec_spawn_failed'))
      return
    }
    let failure: HttpError | undefined
    let outputBytes = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const killGroup = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
    }
    const cancel = (error: HttpError) => {
      if (failure) return
      failure = error
      killGroup()
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    const disconnected = () => cancel(new HttpError(499, 'exec_client_disconnected'))
    const timer = setTimeout(() => cancel(new HttpError(408, 'exec_timeout')), input.timeoutMs)
    request.once('aborted', disconnected)
    response.once('close', disconnected)
    const collect = (parts: Buffer[], chunk: Buffer) => {
      if (failure) return
      outputBytes += chunk.length
      if (outputBytes > input.maxOutputBytes) {
        cancel(new HttpError(413, 'exec_output_limit'))
        return
      }
      parts.push(chunk)
    }
    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', () => cancel(new HttpError(502, 'exec_spawn_failed')))
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      // Closing stdin early is valid, including a command exiting nonzero.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED')
        cancel(new HttpError(502, 'exec_stdin_failed'))
    })
    // Descendants can keep inherited pipes open after the direct child exits.
    // Stop them now; `close` still waits for the remaining output to drain.
    child.once('exit', killGroup)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      request.off('aborted', disconnected)
      response.off('close', disconnected)
      if (failure) reject(failure)
      else
        resolve({
          returncode: code ?? -(signal ? constants.signals[signal] : 1),
          stdout_base64: Buffer.concat(stdout).toString('base64'),
          stderr_base64: Buffer.concat(stderr).toString('base64'),
        })
    })
    child.stdin?.end(input.stdin)
    if (request.aborted || response.destroyed) disconnected()
  })
}

export function registerExecRoute(router: Router): void {
  router.add('POST', '/v1/exec', async (request, response) => {
    executionUid()
    let body: Record<string, unknown>
    try {
      body = await readJsonObject(request, MAX_EXEC_BODY_BYTES)
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, 'invalid_body')
    }
    const input = parseExec(body)
    // Re-read the trusted policy after receiving a potentially large body.
    const uid = executionUid()
    try {
      const result = await execute(input, request, response)
      if (!response.destroyed) sendJson(response, 200, { uid, ...result })
    } catch (error) {
      if (!response.destroyed) throw error
    }
  })
}
