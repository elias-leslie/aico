import { afterEach, describe, expect, it } from 'vitest'
import { getAgentHubVoiceWsUrl, getWsUrl } from './api-config'

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

  it('uses configured Agent Hub URL for voice websocket routing', () => {
    setLocation('https://aico.example.com/')
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
})
