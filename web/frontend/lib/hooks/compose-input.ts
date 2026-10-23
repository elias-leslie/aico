import type { ATermHandle } from '@/components/a-term.types'

export async function commitComposeInput(
  handles: Map<string, ATermHandle>,
  sessionId: string,
  text: string,
  action: 'insert' | 'send',
): Promise<boolean> {
  const handle = handles.get(sessionId)
  if (handle?.status !== 'connected' || !text) return false
  if (action === 'send' && /[\r\n]/.test(text)) return false
  await handle.pasteInput(text)
  // A queued paste may outlive a disconnect or a pane replacement.
  const current = handles.get(sessionId)
  if (!current || current !== handle || current.status !== 'connected')
    return false
  if (action === 'send') current.sendInput('\r')
  return true
}
