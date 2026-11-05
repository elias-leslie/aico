import { describe, expect, it } from 'vitest'
import { checkRequest, checkUpgrade, hostAllowed, phoneTargetAllowed } from './guard'

const config = {
  allowedHostnames: ['localhost', '127.0.0.1', 'app.example'],
  allowedOrigins: ['http://localhost:3002', 'https://app.example'],
}

describe('guard', () => {
  it('answers loopback names and the public host on any port, nothing else', () => {
    expect(hostAllowed('localhost:3002', config)).toBe(true)
    expect(hostAllowed('APP.example', config)).toBe(true)
    expect(hostAllowed('127.0.0.1', config)).toBe(true)
    expect(hostAllowed('evil.example:3002', config)).toBe(false)
    expect(hostAllowed('localhost.evil.example', config)).toBe(false)
    expect(hostAllowed(undefined, config)).toBe(false)
    expect(hostAllowed('localhost:3002/x', config)).toBe(false)
  })

  it('refuses writes from a foreign Origin; reads and Origin-less callers pass', () => {
    const host = 'localhost:3002'
    expect(checkRequest('GET', { host, origin: 'https://evil.example' }, config)).toBeNull()
    expect(checkRequest('POST', { host, origin: 'https://evil.example' }, config)).toBe(
      'origin_not_allowed',
    )
    expect(checkRequest('DELETE', { host, origin: 'null' }, config)).toBe('origin_not_allowed')
    expect(checkRequest('PATCH', { host, origin: 'https://app.example' }, config)).toBeNull()
    expect(checkRequest('PUT', { host }, config)).toBeNull()
    expect(checkRequest('GET', { host: 'rebind.example' }, config)).toBe('host_not_allowed')
  })

  it('refuses a WebSocket from a foreign Origin or host', () => {
    expect(checkUpgrade({ host: 'localhost', origin: 'http://localhost:3002' }, config)).toBeNull()
    expect(checkUpgrade({ host: 'localhost' }, config)).toBeNull()
    expect(checkUpgrade({ host: 'localhost', origin: 'http://localhost:9999' }, config)).toBe(
      'origin_not_allowed',
    )
    expect(checkUpgrade({ host: 'evil.example', origin: 'https://app.example' }, config)).toBe(
      'host_not_allowed',
    )
  })
})

describe('phone hosts', () => {
  const phone = { ...config, phoneHosts: ['phone.example'] }
  const host = 'phone.example'

  it('serve the phone routes and nothing else, and never a WebSocket', () => {
    expect(checkRequest('GET', { host }, phone, '/api/app/items?a=1')).toBeNull()
    expect(checkRequest('POST', { host }, phone, '/api/app/items/ab12/act')).toBeNull()
    expect(checkRequest('GET', { host }, phone, '/api/status')).toBe('host_not_allowed')
    expect(checkRequest('GET', { host }, phone)).toBe('host_not_allowed')
    expect(
      checkRequest('POST', { host, origin: 'https://evil.example' }, phone, '/api/app/act'),
    ).toBe('host_not_allowed')
    expect(checkUpgrade({ host }, phone)).toBe('host_not_allowed')
    expect(hostAllowed(host, phone)).toBe(false)
  })

  it('read the raw request target strictly', () => {
    for (const ok of ['/api/app/health', '/api/app/items/a-b_c.d%3A1/act', '/api/app/stream?x=1'])
      expect(phoneTargetAllowed(ok)).toBe(true)
    for (const bad of [
      '/api/app',
      '/api/app/',
      '/api/apps/health',
      '/api/app/../x',
      '/api/app/./x',
      '/api/app/a/../../x',
      '/api/app/%2e%2e/x',
      '/api/app/a%2Fb',
      '/api/app/a%5Cb',
      '/api/app/a\\b',
      '/api/app//x',
      '/api/app/x#frag',
      '/api/app/x y',
      'http://phone.example/api/app/x',
    ])
      expect([bad, phoneTargetAllowed(bad)]).toEqual([bad, false])
  })
})

it('allows only secret canary POST routes on the legacy phone host', () => {
  const config = {
    allowedHostnames: ['aico.example.test'],
    allowedOrigins: [],
    phoneHosts: ['nightshift.example.test'],
  }
  const path = `/hooks/canary/${'x'.repeat(40)}`
  expect(checkRequest('POST', { host: 'nightshift.example.test' }, config, path)).toBeNull()
  expect(checkRequest('GET', { host: 'nightshift.example.test' }, config, path)).toBe(
    'host_not_allowed',
  )
  expect(
    checkRequest(
      'POST',
      { host: 'nightshift.example.test' },
      config,
      '/hooks/canary/../api/grants',
    ),
  ).toBe('host_not_allowed')
})
