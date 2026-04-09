import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildApiUrl,
  getAgentHubVoiceWsUrl,
  getApiBaseUrl,
  getWsUrl,
} from './api-config'

const originalLocation = window.location
const originalAgentHubUrl = process.env.NEXT_PUBLIC_AGENT_HUB_URL

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
    process.env.NEXT_PUBLIC_AGENT_HUB_URL = originalAgentHubUrl
  })

  it('uses backend localhost websocket on desktop localhost development', () => {
    setLocation('http://localhost:3002/')

    expect(getWsUrl('/ws/a-term/session-1')).toBe('ws://localhost:3002/ws/a-term/session-1')
  })

  it('uses same-origin websocket routing for emulator hosts', () => {
    setLocation('http://10.0.2.2:3002/')

    expect(getWsUrl('/ws/a-term/session-1')).toBe(
      'ws://10.0.2.2:3002/ws/a-term/session-1',
    )
  })

  it('uses same-origin secure websocket routing in production', () => {
    setLocation('https://a-term.summitflow.dev/')

    expect(getWsUrl('/ws/a-term/session-1')).toBe(
      'wss://a-term.summitflow.dev/ws/a-term/session-1',
    )
  })

  it('getApiBaseUrl returns empty string on client-side for same-origin routing', () => {
    setLocation('http://localhost:3002/')

    expect(getApiBaseUrl()).toBe('')
  })

  it('buildApiUrl concatenates base URL with path on client-side', () => {
    setLocation('http://localhost:3002/')

    expect(buildApiUrl('/api/a-term/sessions')).toBe('/api/a-term/sessions')
  })

  it('uses backend localhost websocket for 127.0.0.1 development', () => {
    setLocation('http://127.0.0.1:3002/')

    expect(getWsUrl('/ws/a-term/session-1')).toBe('ws://127.0.0.1:3002/ws/a-term/session-1')
  })

  it('uses configured Agent Hub URL for voice websocket routing', () => {
    setLocation('https://a-term.summitflow.dev/')
    process.env.NEXT_PUBLIC_AGENT_HUB_URL = 'https://agent-hub.example.com'

    expect(getAgentHubVoiceWsUrl()).toBe(
      'wss://agent-hub.example.com/api/voice/ws?user_id=a-term&app=aTerm',
    )
  })

  it('falls back to same-host Agent Hub websocket routing', () => {
    setLocation('http://192.168.1.50:3002/')
    delete process.env.NEXT_PUBLIC_AGENT_HUB_URL

    expect(getAgentHubVoiceWsUrl()).toBe(
      'ws://192.168.1.50:8003/api/voice/ws?user_id=a-term&app=aTerm',
    )
  })

  describe('server-side (no window)', () => {
    const originalWindow = globalThis.window

    beforeEach(() => {
      // Simulate server-side by removing window
      // @ts-expect-error -- deliberately removing window for SSR simulation
      delete globalThis.window
    })

    afterEach(() => {
      globalThis.window = originalWindow
    })

    it('getApiBaseUrl returns localhost backend URL on server-side', () => {
      expect(getApiBaseUrl()).toBe('http://127.0.0.1:8002')
    })

    it('buildApiUrl returns full localhost URL on server-side', () => {
      expect(buildApiUrl('/api/a-term/sessions')).toBe(
        'http://127.0.0.1:8002/api/a-term/sessions',
      )
    })

    it('getWsUrl returns localhost websocket URL on server-side', () => {
      expect(getWsUrl('/ws/a-term/session-1')).toBe(
        'ws://127.0.0.1:8002/ws/a-term/session-1',
      )
    })

    it('prefers the configured runtime backend port on server-side', () => {
      process.env.A_TERM_PORT = '8123'

      expect(getApiBaseUrl()).toBe('http://127.0.0.1:8123')
      expect(getWsUrl('/ws/a-term/session-1')).toBe(
        'ws://127.0.0.1:8123/ws/a-term/session-1',
      )

      delete process.env.A_TERM_PORT
    })
  })
})
