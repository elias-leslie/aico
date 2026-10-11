import { describe, expect, it, vi } from 'vitest'
import { deliverSelectionToSession } from './selection-delivery'

const record = { kind: 'dom', snippet: 'Save button' }

describe('selection delivery through Tether inject', () => {
  it('injects one compact reference and toasts only while still current', async () => {
    const inject = vi.fn(async () => {})
    const delivered = vi.fn()
    await deliverSelectionToSession(
      [record, { kind: 'empty' }],
      { isCurrent: () => true, inject, delivered },
      vi.fn(),
    )
    expect(inject).toHaveBeenCalledWith('[dom: "Save button"] ')
    expect(delivered).toHaveBeenCalledWith([record])
  })

  it('sends nothing for empty selections, no target or a stale view', async () => {
    const inject = vi.fn(async () => {})
    await deliverSelectionToSession(
      [{ kind: 'empty' }],
      { isCurrent: () => true, inject, delivered: vi.fn() },
      vi.fn(),
    )
    await deliverSelectionToSession([record], null, vi.fn())
    await deliverSelectionToSession(
      [record],
      { isCurrent: () => false, inject, delivered: vi.fn() },
      vi.fn(),
    )
    expect(inject).not.toHaveBeenCalled()
  })

  it('reports a refused inject once and never retries', async () => {
    const error = new Error('stale_generation')
    const inject = vi.fn(async () => {
      throw error
    })
    const onFailure = vi.fn()
    const delivered = vi.fn()
    await deliverSelectionToSession(
      [record],
      { isCurrent: () => true, inject, delivered },
      onFailure,
    )
    expect(inject).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(error)
    expect(delivered).not.toHaveBeenCalled()
  })
})
