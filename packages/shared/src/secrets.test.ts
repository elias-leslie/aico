import { describe, expect, it } from 'vitest'
import { HIDDEN_KEY, HIDDEN_PASSWORD, HIDDEN_TOKEN, maskSecrets } from './secrets'

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
