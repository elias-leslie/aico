import { describe, expect, it } from 'vitest'
import { HIDDEN_KEY, HIDDEN_PASSWORD, HIDDEN_TOKEN, maskKnownSecrets, maskSecrets } from './secrets'

// Fake values only, built in pieces so no scanner mistakes them for real ones.
const fake = {
  telegram: `${'7012345678'}:${'AAFakeFakeFake_0123456789abcdefXYZ'}w`,
  openai: `sk-${'proj-'}${'FakeKey0123456789abcdefGHIJ'}`,
  anthropic: `sk-${'ant-api03-'}${'Fake0123456789abcdefghijKLMNOP'}`,
  github: `ghp_${'Fake0123456789abcdefghijklmnopqrstuv'}`,
  githubPat: `github_pat_${'11FAKE0123456789_abcdefghijklmnopqrstuvwxyz'}`,
  aws: `AKIA${'FAKE0123456789AB'}`,
  slack: `xoxb-${'1234567890-fakefakefake'}`,
  google: `AIza${'SyFake0123456789abcdefghijklmnopqrs'}`,
  jwt: `eyJ${'hbGciOiJIUzI1NiJ9'}.${'eyJzdWIiOiJmYWtlIn0'}.${'FakeSignature0123456789'}`,
  hex: `${'0123456789abcdef'.repeat(2)}fedcba98`,
  base64: `${'Zm9vQmFyQmF6'}${'Q3J1eDEyMzQ1Njc4OTBxV2VS'}tYu`,
}

describe('maskSecrets', () => {
  it.each(Object.entries(fake))('hides a %s-shaped token', (_kind, value) => {
    const masked = maskSecrets(`bot setup: ${value} done`)
    expect(masked).not.toContain(value)
    expect(masked).toContain(HIDDEN_TOKEN)
    expect(masked.startsWith('bot setup: ')).toBe(true)
    expect(masked.endsWith(' done')).toBe(true)
  })

  it('hides labelled passwords and tokens but keeps the label', () => {
    expect(maskSecrets('wifi password: Hunter2-fake')).toBe(`wifi password: ${HIDDEN_PASSWORD}`)
    expect(maskSecrets('TELEGRAM_BOT_TOKEN="abc123-fake"')).toBe(
      `TELEGRAM_BOT_TOKEN=${HIDDEN_TOKEN}`,
    )
    expect(maskSecrets('api_key = shortfake and more')).toBe(`api_key = ${HIDDEN_TOKEN} and more`)
    expect(maskSecrets('token=sk-fakefakefakefakefake')).toBe(`token=${HIDDEN_TOKEN}`)
    expect(maskSecrets('Authorization: Bearer fakeBearerValue.0123')).toBe(
      `Authorization: Bearer ${HIDDEN_TOKEN}`,
    )
  })

  it('hides a private key block, whole or cut off', () => {
    const fence = (edge: string, kind: string) => `-----${edge} ${kind} ${'PRIVATE'} KEY-----`
    const block = `${fence('BEGIN', 'OPENSSH')}\nZmFrZQ==\n${fence('END', 'OPENSSH')}`
    expect(maskSecrets(`key:\n${block}\nafter`)).toBe(`key:\n${HIDDEN_KEY}\nafter`)
    expect(maskSecrets(`${fence('BEGIN', 'RSA')} ZmFrZQ`)).toBe(HIDDEN_KEY)
  })

  it('leaves ordinary notes alone', () => {
    const plain = [
      'Buy milk, eggs and 2 loaves of bread',
      'Call the dentist at 10:30 on 2026-11-06',
      'https://example.com/projects/aico/notes?id=abcdef012345',
      '/srv/workspaces/projects/aico/packages/web-frontend/components',
      'a-very-long-kebab-case-file-name-for-the-project-2024.md',
      'We used 3000 tokens yesterday',
      'Passwords should be long',
      '',
    ]
    for (const text of plain) expect(maskSecrets(text)).toBe(text)
  })
})

describe('maskKnownSecrets', () => {
  const extra = {
    gitlab: `glpat-${'Fake0123456789abcdefg'}`,
    stripe: `sk_${'live'}_${'Fake0123456789abcdefghij'}`,
    npm: `npm_${'Fake0123456789abcdefghijklmnopqrstuv'}`,
    huggingface: `hf_${'Fake0123456789abcdefghijklmnopqrstuvw'}`,
    googleOauth: `ya29.${'Fake0123456789abcdefghijklmnopqrstuv'}`,
    sendgrid: `SG.${'Fake0123456789abcdefgh'}.${'Fake0123456789abcdefghijklmnopqrstuvwxyz012'}`,
  }
  const shaped = {
    ...Object.fromEntries(Object.entries(fake).filter(([k]) => k !== 'hex' && k !== 'base64')),
    ...extra,
  }

  it.each(Object.entries(shaped))(
    'hides a %s-shaped token in prose and in JSON',
    (_kind, value) => {
      for (const text of [
        `found ${value} here`,
        JSON.stringify({ command: `curl -H "x: ${value}"` }),
      ]) {
        const masked = maskKnownSecrets(text)
        expect(masked).not.toContain(value)
        expect(masked).toContain(HIDDEN_TOKEN)
      }
    },
  )

  it('hides bearer values and url passwords but keeps the rest', () => {
    expect(maskKnownSecrets('Authorization: Bearer fakeBearerValue.0123')).toBe(
      `Authorization: Bearer ${HIDDEN_TOKEN}`,
    )
    expect(maskKnownSecrets('git clone https://owner:fakepass123@example.com/r.git')).toBe(
      `git clone https://owner:${HIDDEN_TOKEN}@example.com/r.git`,
    )
  })

  it('hides a private key block inside escaped JSON', () => {
    const fence = (edge: string) => `-----${edge} RSA ${'PRIVATE'} KEY-----`
    const text = JSON.stringify({ text: `${fence('BEGIN')}\nZmFrZQ==\n${fence('END')}\ndone` })
    const masked = maskKnownSecrets(text)
    expect(masked).toContain(HIDDEN_KEY)
    expect(masked).not.toContain('ZmFrZQ')
    expect(masked).toContain('done')
  })

  it('leaves hashes, uuids, base64 data, labels and prose alone', () => {
    const plain = [
      'commit 53a307d9e4b1c2d3a4f5061728394a5b6c7d8e9f',
      'sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'session 6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b',
      `data:image/png;base64,iVBORw0KGgo${'AAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg'.repeat(3)}`,
      'Bearer authentication is used here, and password: Hunter2 stays in a log',
      'api_key=somevalue token: abc123 sk-short',
      'we asked at 1730000000:00 for AKIA only',
      'https://example.com:8080/path user@host',
      'Zm9vQmFyQmF6Q3J1eDEyMzQ1Njc4OTBxV2VSdFl1SW9QYXNkZmdoamts',
    ]
    for (const text of plain) expect(maskKnownSecrets(text)).toBe(text)
  })
})
