// Sending a file to the host a remote session runs on. The bytes go over the
// link's ssh master (never a new connection) into a private uploads folder
// there, and the host's own path comes back for the program to read. The
// folder is the caller's config (`DEFAULT_REMOTE_UPLOAD_DIR` unless set).

import { spawn } from 'node:child_process'
import { type RemoteHost, SSH_BIN, SSH_MUX_ONLY, shellQuote } from './remote'

/** Under the host user's home: `~/` is expanded there, not here. */
export const DEFAULT_REMOTE_UPLOAD_DIR = '~/.cache/aico/uploads'

const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

// $1 folder, $2 file name, $3 age in minutes after which older uploads go,
// $4 byte count. The folder is private (umask 077), the file is never
// overwritten (noclobber), a short write (the link dropped mid-stream) is
// removed, and the absolute path is the only thing printed. No single quotes
// in here: the host's shell reads the whole command as one quoted word.
const REMOTE_SCRIPT = [
  'd=$1',
  'case $d in "~/"*) d=$HOME/$(printf "%s" "$d" | cut -c3-);; esac',
  'umask 077',
  'mkdir -p "$d" || exit 1',
  'find "$d" -maxdepth 1 -type f -mmin "+$3" -delete 2>/dev/null',
  'set -C',
  'cat > "$d/$2" || exit 1',
  'if [ "$(wc -c < "$d/$2")" -ne "$4" ]; then rm -f "$d/$2"; exit 1; fi',
  'printf "%s\\n" "$d/$2"',
].join('\n')

export interface RemoteUploadOptions {
  /** Folder on the host; `~/…` is under its home. */
  dir: string
  /** Uploads older than this are deleted from that folder on the next send. */
  maxAgeMs: number
  /** Tests pass a fake. */
  spawnProcess?: typeof spawn
}

/** `offline`: ssh itself could not reach the host (255, or no link); `failed`: the host answered but did not store the file. */
export class RemoteUploadError extends Error {
  constructor(
    readonly kind: 'offline' | 'failed',
    readonly host: string,
    detail: string,
  ) {
    super(detail)
    this.name = 'RemoteUploadError'
  }
}

/** The ssh argv that stores stdin as `<dir>/<name>` on the host. */
export function remoteUploadArgv(
  remote: RemoteHost,
  dir: string,
  name: string,
  size: number,
  maxAgeMs: number,
): string[] {
  if (!FILE_NAME.test(name)) throw new Error('unexpected upload name')
  if (!/^(?:~\/|\/)[^\0\n]*$/.test(dir)) throw new Error('unexpected upload folder')
  const minutes = Math.max(1, Math.ceil(maxAgeMs / 60_000))
  return [
    SSH_BIN,
    ...SSH_MUX_ONLY,
    '-S',
    remote.control,
    remote.alias,
    '--',
    'sh',
    '-c',
    shellQuote(REMOTE_SCRIPT),
    'sh',
    shellQuote(dir),
    shellQuote(name),
    String(minutes),
    String(size),
  ]
}

/** Store `content` on the host as `name`; resolves to its absolute path there. */
export function uploadToHost(
  remote: RemoteHost,
  content: Uint8Array,
  name: string,
  options: RemoteUploadOptions,
): Promise<string> {
  const [bin, ...args] = remoteUploadArgv(
    remote,
    options.dir,
    name,
    content.length,
    options.maxAgeMs,
  )
  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let settled = false
    const finish = (error: RemoteUploadError | null, path?: string) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(path as string)
    }
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      err += String(chunk).slice(0, 2000)
    })
    child.on('error', (error) =>
      finish(new RemoteUploadError('offline', remote.host, error.message)),
    )
    // A host that hangs up early closes stdin on us; the exit code says why.
    child.stdin?.on('error', () => {})
    child.on('close', (code) => {
      const path = out.trim()
      if (code === 0 && path.startsWith('/') && path.endsWith(`/${name}`)) return finish(null, path)
      const detail = err.trim() || `exit ${code}`
      finish(new RemoteUploadError(code === 255 ? 'offline' : 'failed', remote.host, detail))
    })
    child.stdin?.end(Buffer.from(content.buffer, content.byteOffset, content.byteLength))
  })
}
