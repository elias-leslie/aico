import { describe, expect, it } from 'vitest'
import { settingsPlaceAt } from './settings-places'

describe('settingsPlaceAt', () => {
  it('finds a setup place by its path, with or without a trailing slash', () => {
    expect(settingsPlaceAt('/logins')?.label).toBe('Logins')
    expect(settingsPlaceAt('/agents/')?.label).toBe('Context')
    expect(settingsPlaceAt('/app')?.label).toBe('Phone app')
  })
  it('leaves every other page alone', () => {
    expect(settingsPlaceAt('/')).toBeUndefined()
    expect(settingsPlaceAt('/status')).toBeUndefined()
    expect(settingsPlaceAt('/logins/other')).toBeUndefined()
  })
})
