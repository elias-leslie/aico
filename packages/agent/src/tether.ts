// Tells Tether about a run (its session history, `aico sessions`, and the live state of a
// run Tether started): pushed at the run's start and end. Tether never reads agent.db. A
// Tether that is down or refuses is logged; the run goes on.

import { type AgentRunPush, TetherClient, TetherError, tetherSocketPath } from '@aico/tether-client'
import type { RunReport } from './transcript'

export type PushRun = (report: RunReport) => Promise<void>

export function tetherPush(env: NodeJS.ProcessEnv, log: (line: string) => void): PushRun {
  const client = new TetherClient(tetherSocketPath(env, process.getuid?.()))
  return async (report) => {
    const run: AgentRunPush = {
      cwd: report.cwd,
      role: report.role,
      startedAt: report.startedAt,
      endedAt: report.endedAt,
      outcome: report.outcome,
      tokens: report.tokens,
      toolCalls: report.toolCalls,
      turns: report.turns,
    }
    try {
      await client.pushAgentRun(report.id, run)
    } catch (error) {
      const why =
        error instanceof TetherError ? `Tether refused (${error.code})` : (error as Error).message
      log(`not in the session history: ${why}`)
    }
  }
}
