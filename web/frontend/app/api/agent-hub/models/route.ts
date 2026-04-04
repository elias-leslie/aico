import { NextResponse } from 'next/server'
import { getAgentHubServerUrl } from '@/lib/server/agent-hub'

export async function GET(): Promise<NextResponse> {
  const agentHubUrl = getAgentHubServerUrl()
  if (!agentHubUrl) {
    return NextResponse.json(
      { detail: 'Agent Hub is not configured' },
      { status: 503 },
    )
  }

  try {
    const upstream = await fetch(`${agentHubUrl}/api/models`, {
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
