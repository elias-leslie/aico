import { act, render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { FilesRequest } from '@/lib/files-opener'
import { FilesTab } from './FilesTab'

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
}))
const panel = vi.hoisted(() => ({
  request: null as FilesRequest | null,
  onLocate: (_folder: string | null) => {},
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => nav.params,
}))
vi.mock('@/lib/hooks/use-project-settings', () => ({
  useProjectSettings: () => ({ projects: [], isLoading: false }),
}))
vi.mock('@/components/files/FilesPanel', () => ({
  FilesPanel: (props: typeof panel) => {
    panel.request = props.request
    panel.onLocate = props.onLocate
    return null
  },
}))

beforeEach(() => {
  nav.push.mockClear()
  nav.replace.mockClear()
  nav.params = new URLSearchParams('tab=files&view=shared')
})

it('Back from a file opened from Shared returns to Shared', () => {
  const view = render(<FilesTab />)
  expect(panel.request).toMatchObject({ kind: 'shared' })
  // Opening a shared file: a step Back can undo, not a replaced address.
  act(() => panel.onLocate('/srv/docs'))
  expect(nav.push.mock.calls[0]?.[0]).toContain('path=%2Fsrv%2Fdocs')
  expect(nav.replace).not.toHaveBeenCalled()
  nav.params = new URLSearchParams('tab=files&path=%2Fsrv%2Fdocs')
  view.rerender(<FilesTab />)
  // Its own address doesn't move the view.
  expect(panel.request).toMatchObject({ kind: 'shared' })
  nav.params = new URLSearchParams('tab=files&view=shared')
  view.rerender(<FilesTab />)
  expect(panel.request).toMatchObject({ kind: 'shared' })
  nav.params = new URLSearchParams('tab=files&path=%2Fsrv%2Fdocs')
  view.rerender(<FilesTab />)
  expect(panel.request).toMatchObject({ kind: 'path', path: '/srv/docs' })
})

it('moving between folders replaces the address', () => {
  nav.params = new URLSearchParams('tab=files&path=%2Fa')
  render(<FilesTab />)
  act(() => panel.onLocate('/b'))
  expect(nav.replace).toHaveBeenCalledOnce()
  expect(nav.push).not.toHaveBeenCalled()
})
