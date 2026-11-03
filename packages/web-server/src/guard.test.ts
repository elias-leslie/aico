import { describe, expect, it } from 'vitest'
import { checkRequest, checkUpgrade, hostAllowed } from './guard'

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
