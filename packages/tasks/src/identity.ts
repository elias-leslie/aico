// Who is acting, from the environment a Tether session sets: the claim owner and the session to
// link. History ids (`claude-code:UUID`, `codex:UUID`) are what `aico sessions` lists.

import { userInfo } from 'node:os'
import type { Caller } from './tasks'

/** Tool slug (AICO_AGENT_SLUG) to the env var holding the tool's own session id. */
const TOOL_SESSION_VAR: Record<string, string> = {
  'claude-code': 'CLAUDE_CODE_SESSION_ID',
  codex: 'CODEX_THREAD_ID',
}

export function callerFromEnv(env: NodeJS.ProcessEnv): Caller {
  const tether = env.AICO_SESSION_ID?.trim() || null
  const slug = env.AICO_AGENT_SLUG?.trim() ?? ''
  const own = TOOL_SESSION_VAR[slug] ? env[TOOL_SESSION_VAR[slug] as string]?.trim() : ''
  const historyId = own ? `${slug}:${own}` : null
  const owner = env.AICO_CLAIM_OWNER?.trim() || tether || safeUser()
  const id = historyId ?? tether
  return id ? { owner, session: { id, tether } } : { owner }
}

function safeUser(): string {
  try {
    return userInfo().username
  } catch {
    return 'cli'
  }
}
