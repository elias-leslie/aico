import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Pairing } from './app-pairing'
import { canonical, deviceIdOf, PhoneRegistry } from './app-phones'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('pairs and re-pairs a signed test phone once, while an existing phone remains paired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-pair-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'gate.json'),
    JSON.stringify({ cid: 'fixture.access', csec: 'fixture-service-token' }),
  )
  writeFileSync(
    join(dir, 'options.json'),
    JSON.stringify({
      project_id: 'fixture',
      app_id: 'fixture',
      api_key: 'fixture',
      sender_id: 'fixture',
    }),
  )
  const phones = new PhoneRegistry(join(dir, 'phones.json'), 1)
  writeFileSync(
    phones.path,
    JSON.stringify([{ id: 'existing', name: 'Existing phone', fcm_token: 'keep' }]),
  )
  const pairing = new Pairing(phones, {
    base: 'https://phone.example',
    origins: ['https://aico.example'],
    gateFile: join(dir, 'gate.json'),
    optionsFile: join(dir, 'options.json'),
    codesFile: join(dir, 'codes.json'),
    ttlSeconds: 600,
  })
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pub = keys.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-65)
    .toString('base64url')
  const attempt = (code: string, token = 'test-token') => {
    const body = Buffer.from(
      JSON.stringify({
        sig_pub: pub,
        enc_pub: pub,
        auth: Buffer.alloc(16).toString('base64url'),
        code,
        model: 'Test phone',
        fcm_token: token,
      }),
    )
    const ts = '1000'
    const headers = {
      'x-nightshift-ts': ts,
      'x-nightshift-sig': sign(
        'sha256',
        Buffer.from(canonical('POST', '/api/app/register', ts, body)),
        keys.privateKey,
      ).toString('base64url'),
    }
    return pairing.register(body, '/api/app/register', headers, 1000)
  }
  const issue = () =>
    JSON.parse(
      Buffer.from(
        pairing.issue('Test', 1000).split('?p=')[1].split('#')[0],
        'base64url',
      ).toString(),
    ).code as string
  const code = issue()
  await expect(pairing.register(Buffer.from('{}'), '/api/app/register', {}, 1000)).rejects.toThrow()
  await expect(attempt(code)).resolves.toMatchObject({ device_id: deviceIdOf(pub) })
  await expect(attempt(code)).rejects.toThrow(/expired or used/)
  await attempt(issue(), 'replacement')
  expect(phones.all()).toHaveLength(2)
  expect(phones.get('existing')?.fcm_token).toBe('keep')
  expect(phones.get(deviceIdOf(pub))?.fcm_token).toBe('replacement')
})
