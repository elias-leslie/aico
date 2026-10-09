import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARM_MS, createArmGuard, needsConfirm } from './arm-guard'

type Target = { name: string }

function harness() {
  const armed = new Set<Target>()
  const guard = createArmGuard<Target>({
    onArm: (t) => armed.add(t),
    onDisarm: (t) => armed.delete(t),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  })
  return { guard, armed }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('needsConfirm', () => {
  it('guards only actions that end or replace the focused session', () => {
    expect(needsConfirm('replace:codex')).toBe(true)
    expect(needsConfirm('project:aico')).toBe(true)
    expect(needsConfirm('retire-widget')).toBe(true)
    expect(needsConfirm('new:codex')).toBe(false)
    expect(needsConfirm('voice')).toBe(false)
  })
})

describe('createArmGuard', () => {
  const row = { name: 'row' }
  const icon = { name: 'icon' }

  it('runs an unguarded action immediately without arming', () => {
    const { guard, armed } = harness()
    expect(guard.guard('voice', row)).toBe(false)
    expect(armed.size).toBe(0)
  })

  it('arms on the first activation and confirms on the second', () => {
    const { guard, armed } = harness()
    expect(guard.guard('retire-widget', row)).toBe(true)
    expect([...armed]).toEqual([row])
    expect(guard.guard('retire-widget', row)).toBe(false)
    expect(armed.size).toBe(0)
  })

  it('moves the arm to a different target instead of confirming', () => {
    const { guard, armed } = harness()
    guard.guard('replace:codex', row)
    expect(guard.guard('replace:claude', icon)).toBe(true)
    expect([...armed]).toEqual([icon])
    // The old target needs a fresh first click again.
    expect(guard.guard('replace:codex', row)).toBe(true)
  })

  it('expires the arm after ARM_MS', () => {
    const { guard, armed } = harness()
    guard.guard('retire-widget', row)
    vi.advanceTimersByTime(ARM_MS - 1)
    expect(armed.has(row)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(armed.size).toBe(0)
    expect(guard.guard('retire-widget', row)).toBe(true)
  })

  it('restarts the expiry window when re-armed', () => {
    const { guard, armed } = harness()
    guard.guard('retire-widget', row)
    vi.advanceTimersByTime(ARM_MS - 1)
    guard.guard('replace:codex', icon)
    vi.advanceTimersByTime(ARM_MS - 1)
    expect([...armed]).toEqual([icon])
    vi.advanceTimersByTime(1)
    expect(armed.size).toBe(0)
  })

  it('releases only the armed target', () => {
    const { guard, armed } = harness()
    guard.guard('retire-widget', row)
    guard.release(icon)
    expect(armed.has(row)).toBe(true)
    guard.release(row)
    expect(armed.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(guard.guard('retire-widget', row)).toBe(true)
  })

  it('disarms everything on an explicit disarm', () => {
    const { guard, armed } = harness()
    guard.guard('retire-widget', row)
    guard.disarm()
    expect(armed.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    guard.disarm()
  })
})
