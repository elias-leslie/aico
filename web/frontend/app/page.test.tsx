import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import Home from './page'

const mockATermTabs = vi.fn(
  ({
    projectId,
    projectPath,
    className,
  }: {
    projectId?: string
    projectPath?: string
    className?: string
  }) => (
    <div
      data-testid="a-term-tabs"
      data-class-name={className ?? ''}
      data-project-id={projectId ?? ''}
      data-project-path={projectPath ?? ''}
    />
  ),
)

vi.mock('@/components/ATermTabs', () => ({
  ATermTabs: (props: {
    projectId?: string
    projectPath?: string
    className?: string
  }) => mockATermTabs(props),
}))

describe('Home page', () => {
  it('forwards resolved search params to ATermTabs', async () => {
    const view = await Home({
      searchParams: Promise.resolve({
        project: 'agent-hub',
        dir: '/home/demo/projects/agent-hub',
      }),
    })

    render(view)

    expect(screen.getByTestId('a-term-tabs')).toHaveAttribute(
      'data-project-id',
      'agent-hub',
    )
    expect(screen.getByTestId('a-term-tabs')).toHaveAttribute(
      'data-project-path',
      '/home/demo/projects/agent-hub',
    )
    expect(screen.getByTestId('a-term-tabs')).toHaveAttribute(
      'data-class-name',
      'flex-1 min-h-0',
    )
  })

  it('uses the first non-empty value when search params are arrays', async () => {
    const view = await Home({
      searchParams: Promise.resolve({
        project: ['', 'portfolio-ai'],
        dir: ['', '/home/demo/projects/portfolio-ai'],
      }),
    })

    render(view)

    expect(screen.getByTestId('a-term-tabs')).toHaveAttribute(
      'data-project-id',
      'portfolio-ai',
    )
    expect(screen.getByTestId('a-term-tabs')).toHaveAttribute(
      'data-project-path',
      '/home/demo/projects/portfolio-ai',
    )
  })
})
