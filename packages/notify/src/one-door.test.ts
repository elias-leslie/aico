// Everything that reaches the owner's phone or desktop goes through the door (notifier.ts) or is
// named here with why it can't. A new direct send fails this check: bring it through `aico notify`
// or POST /api/notices, or add it here and show it in Settings > Notifications.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))

/** A way to reach the owner, and the only files allowed to use it. */
const DIRECT_SENDS: { what: string; pattern: RegExp; only: string[] }[] = [
  {
    what: "FCM's send URL",
    pattern: /fcm\.googleapis\.com/,
    only: ['packages/notify/src/fcm.ts', 'native/host-steward/host_steward/fcm_wire.py'],
  },
  {
    what: 'the FCM sender in packages/notify',
    pattern: /new FcmSender\(/,
    only: ['packages/web-server/src/notify.ts'],
  },
  {
    what: 'the Python FCM wire',
    pattern: /fcm_wire|fcm\.fcm_push\(/,
    only: [
      // Sends the silent home-off ping (type p): the phone shows nothing, so there is no switch.
      'native/host-steward/host_steward/jobs/home_off.py',
      'native/host-steward/host_steward/fcm_wire.py',
      // Keeps the send token fresh; sends nothing.
      'native/host-steward/host_steward/fcm_token.py',
      // Proxmox's own sender: it reads the owner's switches (phone_off in sender.py).
      'native/pve-sender/pve_sender/fcm.py',
      'native/pve-sender/pve_sender/sender.py',
    ],
  },
  {
    what: 'a phone-local notification',
    pattern: /Notifier\.local\(/,
    // Shown in Settings as the rows that have no switch (FIXED_ROWS in web-server notifications.ts).
    only: [
      'native/android/app/src/main/kotlin/dev/summitflow/nightshift/alarm/OutageAlarm.kt',
      'native/android/app/src/main/kotlin/dev/summitflow/nightshift/update/Updater.kt',
      'native/android/app/src/main/kotlin/dev/summitflow/nightshift/push/NsMessagingService.kt',
    ],
  },
  {
    what: 'a desktop notification outside the tray',
    pattern: /notify-send|new Notification\(|\.showNotification\(/,
    only: [],
  },
]

const CODE = /\.(ts|tsx|mts|js|mjs|cjs|py|rs|kt|sh|go)$/
const LEFT_OUT = /(^|\/)(evidence|docs|tests)\/|\.test\.|vendor\/|test_[^/]*\.py$/

function trackedCode(): string[] {
  return execFileSync('git', ['ls-files', 'packages', 'native', 'scripts'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter((file) => CODE.test(file) && !LEFT_OUT.test(file))
}

describe('the one door', () => {
  const files = trackedCode().map((file) => {
    let text = ''
    try {
      text = readFileSync(join(REPO, file), 'utf8')
    } catch {
      // Tracked but deleted in this tree: nothing to scan.
    }
    return { file, text }
  })

  it('scans the real tree', () => {
    expect(files.length).toBeGreaterThan(200)
    expect(files.some(({ file }) => file === 'packages/notify/src/fcm.ts')).toBe(true)
  })

  for (const { what, pattern, only } of DIRECT_SENDS)
    it(`allows ${what} only where it is named`, () => {
      const found = files.filter(({ text }) => pattern.test(text)).map(({ file }) => file)
      expect(found.filter((file) => !only.includes(file))).toEqual([])
    })
})
