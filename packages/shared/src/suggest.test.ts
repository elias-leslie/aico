import { expect, it } from 'vitest'
import { nearest } from './suggest'

it('finds the name a typo was meant for, or none', () => {
  const names = ['sessions', 'share', 'ask', 'run']
  expect(nearest('sesions', names)).toBe('sessions')
  expect(nearest('runs', names)).toBe('run')
  expect(nearest('shre', names)).toBe('share')
  expect(nearest('completely-different', names)).toBeNull()
})
