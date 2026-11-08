import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MockupsPage from './page'

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  params: new URLSearchParams(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => nav.params,
}))

beforeEach(() => nav.replace.mockReset())

describe('the old mockups page', () => {
  it('sends a project’s mockup link to its Designs tab, with a button if that does not happen', () => {
    nav.params = new URLSearchParams('project=aico')
    render(<MockupsPage />)
    expect(nav.replace).toHaveBeenCalledWith(
      '/workbench?tab=designs&project=aico',
    )
    expect(screen.getByRole('link', { name: 'Open Designs' })).toHaveAttribute(
      'href',
      '/workbench?tab=designs&project=aico',
    )
  })

  it('opens the Designs tab on every project when the link names none', () => {
    nav.params = new URLSearchParams()
    render(<MockupsPage />)
    expect(nav.replace).toHaveBeenCalledWith('/workbench?tab=designs')
  })
})
