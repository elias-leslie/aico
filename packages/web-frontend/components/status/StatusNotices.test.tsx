import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StatusRow } from '@/lib/status'
import { StatusNotices } from './StatusNotices'

const machine = (key: string): StatusRow => ({
  id: `${key}/machine`,
  what: key,
  kind: 'machine',
  machine: key,
  state: 'ok',
  meaning: 'Up.',
  updated_at: '2026-11-06T11:58:00Z',
  shown: 'late',
  shown_since: '2026-11-06T11:00:00Z',
})

describe('StatusNotices', () => {
  it('names a silent machine by its Aico name', () => {
    render(
      <StatusNotices
        mode="live"
        rows={[machine('aico'), machine('davion-gem')]}
        hostNames={new Set(['aico'])}
        stale={false}
        readAt={null}
        failedAt={null}
        now={Date.parse('2026-11-06T12:00:00Z')}
        refreshing={false}
        onRefetch={vi.fn()}
        onHosts={vi.fn()}
      />,
    )
    expect(screen.getByText(/Standby isn’t answering/)).toBeVisible()
    expect(screen.getByText(/Proxmox host isn’t answering/)).toBeVisible()
  })
})
