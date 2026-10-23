import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@/lib/hooks/use-agent-tools'
import { AgentToolsSettings } from './AgentToolsSettings'

const update = vi.fn()

const codex: AgentTool = {
  id: 'codex',
  name: 'Codex',
  slug: 'codex',
  command: 'codex --yolo',
  argv: ['codex', '--yolo'],
  process_name: 'codex',
  description: null,
  color: '#123456',
  display_order: 1,
  is_default: false,
  enabled: true,
  aliases: [],
  context_hook: null,
  created_at: null,
  updated_at: null,
}

vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({
    agentTools: [codex],
    create: vi.fn(),
    update,
    remove: vi.fn(),
  }),
}))

describe('AgentToolsSettings', () => {
  beforeEach(() => {
    update.mockReset()
    update.mockResolvedValue(codex)
  })

  it("clears a tool's color in Tether when the color is emptied", async () => {
    render(<AgentToolsSettings />)
    fireEvent.click(screen.getByRole('button', { name: /edit codex/i }))
    fireEvent.change(screen.getByLabelText('Tool color'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ color: null }),
      )
    })
  })

  it('opens a tool with no color of its own with an empty color field', () => {
    codex.color = null
    try {
      render(<AgentToolsSettings />)
      fireEvent.click(screen.getByRole('button', { name: /edit codex/i }))
      expect(screen.getByLabelText('Tool color')).toHaveValue('')
    } finally {
      codex.color = '#123456'
    }
  })
})
