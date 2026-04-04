import { type NextRequest, NextResponse } from 'next/server'
import { getAgentHubServerUrl } from '@/lib/server/agent-hub'

const PASSTHROUGH_HEADERS = [
  'content-type',
  'x-source-client',
  'x-source-path',
] as const

export async function POST(request: NextRequest): Promise<NextResponse> {
  const agentHubUrl = getAgentHubServerUrl()
  if (!agentHubUrl) {
    return NextResponse.json(
      { detail: 'Agent Hub is not configured' },
      { status: 503 },
    )
  }

  const headers = new Headers()
  for (const key of PASSTHROUGH_HEADERS) {
    const value = request.headers.get(key)
    if (value) {
      headers.set(key, value)
    }
  }

  try {
    const upstream = await fetch(`${agentHubUrl}/api/complete`, {
      method: 'POST',
      headers,
      body: await request.text(),
      cache: 'no-store',
    })
    const body = await upstream.text()

    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        detail: error instanceof Error ? error.message : 'Failed to reach Agent Hub',
      },
      { status: 502 },
    )
  }
}
