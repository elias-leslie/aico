import type { NextRequest, NextResponse } from 'next/server'
import {
  AGENT_HUB_PROXY_PASSTHROUGH_HEADERS,
  proxyAgentHubRequest,
} from '@/lib/server/agent-hub-proxy'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const headers = new Headers()
  for (const key of AGENT_HUB_PROXY_PASSTHROUGH_HEADERS) {
    const value = request.headers.get(key)
    if (value) {
      headers.set(key, value)
    }
  }

  return proxyAgentHubRequest({
    method: 'POST',
    path: '/api/complete',
    headers,
    body: await request.text(),
  })
}
