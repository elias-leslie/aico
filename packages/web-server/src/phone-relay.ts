// The phone route of a host whose FCM sender lives elsewhere (CT 190): each phone item goes over
// the ssh alias in AICO_PUSH_SSH to the Proxmox sender (native/pve-sender, push caller `aico`,
// kind `relay`), which sends it to every paired phone with its own root-held credentials. The
// outbox sees one phone, "proxmox"; the item's id is the delivery id, so Proxmox sends it once.

import { execFile } from 'node:child_process'
import type { Device, PhoneSender, SendResult } from '@aico/notify'

const RELAY_TIMEOUT_MS = 30_000
/** ssh's own failure (no connection, refused key): nothing reached Proxmox. */
const SSH_FAILED = 255
/** pve-sender refused the input. */
const REFUSED = 2

export const RELAY_DEVICE: Device = { id: 'proxmox', fcmToken: '', encPub: '', auth: '' }

/** Runs argv with `input` on stdin; resolves with exit code and stdout (null code: killed). */
export type RelayRun = (
  argv: string[],
  input: string,
  timeoutMs: number,
) => Promise<{ code: number | null; out: string }>

const run: RelayRun = (argv, input, timeoutMs) =>
  new Promise((resolve) => {
    const child = execFile(
      argv[0] as string,
      argv.slice(1),
      { timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
        resolve({ code, out: String(stdout) })
      },
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })

export function relaySender(alias: string, exec: RelayRun = run): PhoneSender {
  return {
    devices: () => [RELAY_DEVICE],
    send: (_device, plaintext) => relay(alias, exec, plaintext),
  }
}

async function relay(alias: string, exec: RelayRun, plaintext: Buffer): Promise<SendResult> {
  const item = JSON.parse(plaintext.toString('utf8'))
  const { code, out } = await exec(
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias],
    JSON.stringify({ v: 1, source: 'aico', kind: 'relay', item }),
    RELAY_TIMEOUT_MS,
  )
  if (code === SSH_FAILED) return 'retry'
  // The Proxmox sender refused the item itself (pve-sender exit 2): asking again won't help.
  if (code === REFUSED) return `rejected:${code}`
  let answer: { ok?: unknown } = {}
  try {
    answer = JSON.parse(out.trim().split('\n').at(-1) ?? '')
  } catch {
    // Killed mid-send or an unreadable answer: Proxmox may have sent it.
    return 'unsure'
  }
  // Not ok: no phone route on Proxmox yet, or a phone didn't take it. Its per-phone receipts
  // send each phone at most once, so asking again reaches only the ones still missing.
  return answer.ok === true ? 'sent' : 'retry'
}
