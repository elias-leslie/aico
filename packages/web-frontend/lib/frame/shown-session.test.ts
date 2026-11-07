import { afterEach, describe, expect, it } from 'vitest'
import { homeHref, publishShownSession } from './shown-session'

afterEach(() => publishShownSession(null))

describe('homeHref', () => {
  it('is plain home with no session open', () => {
    expect(homeHref()).toBe('/')
  })

  it('comes back to the session on screen, encoded', () => {
    publishShownSession('claude-code:abc 1')
    expect(homeHref()).toBe('/?session=claude-code%3Aabc%201')
    publishShownSession(null)
    expect(homeHref()).toBe('/')
  })
})
