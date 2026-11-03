import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostsLauncher } from './HostsButton'

const hostState = vi.hoisted(() => ({ hosts: [] as Array<{ name: string }> }))
vi.mock('@/lib/hooks/use-hosts', () => ({ useHosts: () => hostState }))
vi.mock('./HostsSheet', () => ({ HostsSheet: () => null }))

describe('HostsLauncher', () => {
  beforeEach(() => {
    hostState.hosts = []
  })

  it('shows nothing when Aico links to no other host', () => {
    render(<HostsLauncher />)
    expect(screen.queryByRole('button', { name: /Hosts/ })).toBeNull()
  })

  it('shows the Hosts entry once a host is listed', () => {
    hostState.hosts = [{ name: 'agent-work' }]
    render(<HostsLauncher icon />)
    expect(screen.getByRole('button', { name: 'Hosts' })).toBeInTheDocument()
  })
})
