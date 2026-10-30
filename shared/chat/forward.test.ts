import { TetherError } from 'tether/client'
import { describe, expect, it } from 'vitest'
import { failure } from './forward'

describe('chat failure words', () => {
  it("tells Agent Hub's reason when it refuses a message", () => {
    const refused = new TetherError(409, 'workload_unavailable', {
      reason: "working_dir '/x' is outside the known project roots",
    })
    expect(failure(refused).message).toBe(
      "Agent Hub refused: working_dir '/x' is outside the known project roots",
    )
  })

  it('says the session is not ready when there is no reason', () => {
    expect(failure(new TetherError(409, 'workload_unavailable', {})).message).toBe(
      'This session is not ready yet.',
    )
  })
})
