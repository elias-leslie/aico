import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const UNITS = ['packages/tether/deploy/tether@.service', 'scripts/systemd/tether@default.service']
const WAIT = 'podman-user-wait-network-online.service'

describe('Tether unit files', () => {
  it.each(UNITS)('%s starts after the system network is online', (unit) => {
    const text = readFileSync(join(ROOT, unit), 'utf8')
    const section = text.slice(text.indexOf('[Unit]'), text.indexOf('[Service]'))
    expect(section).toContain(`Wants=${WAIT}`)
    expect(section).toContain(`After=${WAIT}`)
  })
})
