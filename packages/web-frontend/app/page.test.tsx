import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Home from './page'

const searchParams = { current: new URLSearchParams() }

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams.current,
}))

vi.mock('@/components/TerminalTabs', () => ({
  TerminalTabs: ({
    projectId,
    projectPath,
    className,
  }: {
    projectId?: string
    projectPath?: string
    className?: string
  }) => (
    <div
      data-testid="terminal-tabs"
      data-class-name={className ?? ''}
      data-project-id={projectId ?? ''}
      data-project-path={projectPath ?? ''}
    />
  ),
}))

describe('Home page', () => {
  beforeEach(() => {
    searchParams.current = new URLSearchParams()
  })

  it('passes the query to TerminalTabs', () => {
    searchParams.current = new URLSearchParams(
      'project=agent-hub&dir=/home/demo/projects/agent-hub',
    )

    render(<Home />)

    const tabs = screen.getByTestId('terminal-tabs')
    expect(tabs).toHaveAttribute('data-project-id', 'agent-hub')
    expect(tabs).toHaveAttribute(
      'data-project-path',
      '/home/demo/projects/agent-hub',
    )
    expect(tabs).toHaveAttribute('data-class-name', 'flex-1 min-h-0')
  })

  it('uses the first non-empty value of a repeated parameter', () => {
    searchParams.current = new URLSearchParams(
      'project=&project=portfolio-ai&dir=&dir=/home/demo/projects/portfolio-ai',
    )

    render(<Home />)

    const tabs = screen.getByTestId('terminal-tabs')
    expect(tabs).toHaveAttribute('data-project-id', 'portfolio-ai')
    expect(tabs).toHaveAttribute(
      'data-project-path',
      '/home/demo/projects/portfolio-ai',
    )
  })
})
