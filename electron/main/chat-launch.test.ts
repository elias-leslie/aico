import { TetherError } from 'tether/client'
import { describe, expect, it, vi } from 'vitest'
import { CHAT_TOOL, createChatLauncher } from './chat-launch'
import { BLANK_SLATE_ID, PERSONAL_WORKSPACE_ID } from './project'

function setup(createSession = vi.fn().mockResolvedValue({ id: 'abc12345' })) {
  const deps = {
    tether: { createSession },
    catalog: { upsert: vi.fn() },
    show: vi.fn(),
    fail: vi.fn(),
  }
  return { deps, launch: createChatLauncher(deps) }
}

describe('new Agent Hub chat', () => {
  it('creates the chat in the project with no prompt, then shows its window', async () => {
    const { deps, launch } = setup()
    await launch('aico')
    expect(deps.tether.createSession).toHaveBeenCalledWith({
      tool: CHAT_TOOL,
      projectId: 'aico',
      size: expect.any(Object),
    })
    expect(deps.catalog.upsert).toHaveBeenCalledWith({ id: 'abc12345' })
    expect(deps.show).toHaveBeenCalledWith('abc12345')
    expect(deps.fail).not.toHaveBeenCalled()
  })

  it("tells Agent Hub's reason when it refuses, and opens nothing", async () => {
    const { deps, launch } = setup(
      vi.fn().mockRejectedValue(new TetherError(422, 'unknown_agent', { reason: 'no coder' })),
    )
    await launch('aico')
    expect(deps.fail).toHaveBeenCalledWith(expect.stringContaining('no coder'))
    expect(deps.show).not.toHaveBeenCalled()
  })

  it('asks for a real project instead of a made-up workspace', async () => {
    for (const id of [BLANK_SLATE_ID, PERSONAL_WORKSPACE_ID]) {
      const { deps, launch } = setup()
      await launch(id)
      expect(deps.tether.createSession).not.toHaveBeenCalled()
      expect(deps.fail).toHaveBeenCalledWith(expect.stringContaining('Pick a project'))
    }
  })
})
