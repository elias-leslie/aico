import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuotaGlance } from '@/lib/frame/quota'
import type { AgentTool } from '@/lib/hooks/use-agent-tools'
import type { ProjectSlot } from '@/lib/utils/slot'
import { ContinueNotice, continueTargets } from './ContinueNotice'

const h = vi.hoisted(() => ({
  push: vi.fn(),
  create: vi.fn(),
  glances: [] as unknown[],
  tools: [] as unknown[],
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))
vi.mock('@/lib/hooks/use-usage', () => ({ useUsage: () => ({ report: null }) }))
vi.mock('@/lib/frame/quota', () => ({ quotaGlances: () => h.glances }))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({ enabledTools: h.tools }),
}))
vi.mock('@/lib/hooks/use-terminal-panes', () => ({
  useTerminalPanes: () => ({ createProjectPane: h.create }),
}))

const glance = (id: string, state: QuotaGlance['state']) =>
  ({
    id,
    name: id === 'claude' ? 'Claude' : 'Codex',
    state,
    left: state === 'left' ? 50 : 0,
    gone: null,
    line: '',
    meaning: `${id} ${state}`,
    warn: state === 'used_up',
  }) as QuotaGlance
const tool = (slug: string, name: string, aliases: string[] = []) =>
  ({ slug, name, aliases, enabled: true }) as AgentTool

const CLAUDE = tool('claude-code', 'Claude', ['claude', 'cc'])
const CODEX = tool('codex', 'Codex')

const slot = (over: Partial<ProjectSlot> = {}): ProjectSlot =>
  ({
    type: 'project',
    projectId: 'aico',
    projectName: 'Aico',
    rootPath: '/srv/aico',
    activeMode: 'claude-code',
    activeSessionId: 'a1b2c3d4',
    can: {},
    showsSessionTitle: false,
    ...over,
  }) as ProjectSlot

describe('continueTargets', () => {
  it('offers the other tools whose subscription has room, only when this one is used up', () => {
    const used = [glance('claude', 'used_up'), glance('codex', 'left')]
    expect(continueTargets('claude', used, [CLAUDE, CODEX])).toEqual([CODEX])
    const fine = [glance('claude', 'left'), glance('codex', 'left')]
    expect(continueTargets('claude', fine, [CLAUDE, CODEX])).toEqual([])
    expect(continueTargets('shell', used, [CLAUDE, CODEX])).toEqual([])
  })

  it('knows a Claude session by its tool slug, though its usage glance is named claude', () => {
    const used = [glance('claude', 'used_up'), glance('codex', 'left')]
    expect(continueTargets('claude-code', used, [CLAUDE, CODEX])).toEqual([
      CODEX,
    ])
    expect(continueTargets('codex', used, [CLAUDE, CODEX])).toEqual([])
  })

  it('counts credits as room and skips a tool that is used up or not known', () => {
    const credits = [glance('claude', 'used_up'), glance('codex', 'credits')]
    expect(continueTargets('claude', credits, [CLAUDE, CODEX])).toEqual([CODEX])
    const none = [glance('claude', 'used_up'), glance('codex', 'unknown')]
    expect(continueTargets('claude', none, [CLAUDE, CODEX])).toEqual([])
  })
})

describe('ContinueNotice', () => {
  beforeEach(() => {
    h.push.mockReset()
    h.create.mockReset()
    h.glances = [glance('claude', 'used_up'), glance('codex', 'left')]
    h.tools = [CLAUDE, CODEX]
  })

  it('says the tool is used up and starts the other tool from this session', async () => {
    h.create.mockResolvedValue({
      sessions: [
        { id: 'sh000000', mode: 'shell' },
        { id: 'ag111111', mode: 'codex' },
      ],
    })
    render(<ContinueNotice slot={slot()} />)
    expect(screen.getByTestId('continue-notice')).toHaveTextContent(
      'Claude is used up',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue in Codex' }))
    await waitFor(() =>
      expect(h.push).toHaveBeenCalledWith('/?session=ag111111'),
    )
    expect(h.create).toHaveBeenCalledWith(
      'Aico',
      'aico',
      '/srv/aico',
      'codex',
      { continueFrom: 'a1b2c3d4' },
    )
  })

  it('says why when the new session could not start, and keeps the button', async () => {
    h.create.mockRejectedValue(new Error('Codex is disabled'))
    render(<ContinueNotice slot={slot()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue in Codex' }))
    await waitFor(() =>
      expect(screen.getByTestId('continue-notice')).toHaveTextContent(
        'Codex is disabled',
      ),
    )
    expect(
      screen.getByRole('button', { name: 'Continue in Codex' }),
    ).toBeEnabled()
    expect(h.push).not.toHaveBeenCalled()
  })

  it('stays out of the way for a shell, a remote host, a chat or a tool with room', () => {
    for (const over of [
      { activeMode: 'shell' },
      { host: 'lab' },
      { chat: true },
    ]) {
      const { unmount } = render(<ContinueNotice slot={slot(over)} />)
      expect(screen.queryByTestId('continue-notice')).toBeNull()
      unmount()
    }
    h.glances = [glance('claude', 'left'), glance('codex', 'left')]
    render(<ContinueNotice slot={slot()} />)
    expect(screen.queryByTestId('continue-notice')).toBeNull()
  })
})
