import type { NextResponse } from 'next/server'
import { proxyAgentHubRequest } from '@/lib/server/agent-hub-proxy'

export async function GET(): Promise<NextResponse> {
  return proxyAgentHubRequest({
    method: 'GET',
    path: '/api/models',
  })
}
