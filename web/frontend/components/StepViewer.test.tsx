import { fireEvent, render, screen } from '@testing-library/react'
import type { RunMember } from 'tether/teams'
import { describe, expect, it, vi } from 'vitest'
import { stepAttention } from '@/lib/attention'
import type { AdHocSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { SessionList } from './SessionList'
import { StepView, StepViewerProvider, useStepViewer } from './StepViewer'

vi.mock('./KeptCheckIns', () => ({ KeptCheckIns: () => null }))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({
    agentTools: [{ slug: 'pi', name: 'Pi', color: null }],
  }),
}))
vi.mock('./AgentHubChat', () => ({
  AgentHubChat: ({ source }: { source: unknown }) => (
    <div data-testid="chat-stub">{JSON.stringify(source)}</div>
  ),
}))

const lead: AdHocSlot = {
  ...SLOT_BASE,
  createdAt: '2026-10-27T00:00:01Z',
  type: 'adhoc',
  sessionId: 'lead',
  name: 'Aico',
  workingDir: null,
  sessionMode: 'pi',
  coordinator: true,
}

const build = {
  id: 'step:r1:build',
  kind: 'step',
  coordinator: false,
  coordinatorId: 'lead',
  runId: 'r1',
  stepKey: 'build',
  title: 'build',
  group: 'working',
  at: 1_000_000_000_000 - 120_000,
  word: 'thinking',
  status: 'running',
  tool: 'pi',
  session: true,
} as unknown as RunMember

const attention = {
  forSlot: () => null,
  forStep: (m: RunMember) => stepAttention(m, 1_000_000_000_000),
  needsYouCount: 0,
  runs: {
    items: [build],
    state: 'ok' as const,
    notice: null,
    needsYouCount: 0,
  },
}

/** The list over the main view, as the app lays them out. */
function Page({ onSelect }: { onSelect: () => void }) {
  const viewer = useStepViewer()
  return (
    <>
      <SessionList slots={[lead]} attention={attention} onSelect={onSelect} />
      {viewer.step && <StepView step={viewer.step} onBack={viewer.close} />}
    </>
  )
}

describe('the step viewer', () => {
  it('opens a running step read-only from the list and goes back', () => {
    render(
      <StepViewerProvider>
        <Page onSelect={vi.fn()} />
      </StepViewerProvider>,
    )
    expect(screen.queryByTestId('step-view')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^build/ }))
    expect(screen.getByTestId('step-view')).toBeInTheDocument()
    expect(screen.getByText('Read only')).toBeInTheDocument()
    expect(screen.getByTestId('chat-stub').textContent).toBe(
      JSON.stringify({ run: 'r1', step: 'build' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to the session' }))
    expect(screen.queryByTestId('step-view')).toBeNull()
  })

  it('closes the step when a session is picked', () => {
    const onSelect = vi.fn()
    render(
      <StepViewerProvider>
        <Page onSelect={onSelect} />
      </StepViewerProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /^build/ }))
    expect(screen.getByTestId('step-view')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Aico/ }))
    expect(onSelect).toHaveBeenCalledWith(lead)
    expect(screen.queryByTestId('step-view')).toBeNull()
  })
})
