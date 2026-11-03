import { afterEach, describe, expect, it } from 'vitest'
import { getWsUrl } from './api-config'

const originalLocation = window.location

function setLocation(url: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL(url),
  })
}

describe('api-config', () => {
  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    })
  })

  it('opens the WebSocket on the page origin', () => {
    setLocation('http://localhost:3002/')
    expect(getWsUrl('/ws/session-1')).toBe('ws://localhost:3002/ws/session-1')

    setLocation('http://10.0.2.2:3002/')
    expect(getWsUrl('/ws/session-1')).toBe('ws://10.0.2.2:3002/ws/session-1')
  })

  it('uses a secure WebSocket on an https page', () => {
    setLocation('https://aico.example.com/')

    expect(getWsUrl('/ws/session-1')).toBe(
      'wss://aico.example.com/ws/session-1',
    )
  })
})
