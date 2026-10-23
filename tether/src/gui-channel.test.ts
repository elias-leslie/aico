import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { EventBus } from './events'
import { GuiChannel } from './gui-channel'

/** Minimal stream double: records NDJSON lines and close/end. */
function stream() {
  const lines: Record<string, unknown>[] = []
  const response = new EventEmitter() as EventEmitter & {
    destroyed: boolean
    writeHead(): void
    write(chunk: string): boolean
    end(chunk?: string): void
  }
  response.destroyed = false
  response.writeHead = () => {}
  response.write = (chunk: string) => {
    lines.push(JSON.parse(chunk))
    return true
  }
  response.end = (chunk?: string) => {
    if (chunk) lines.push(JSON.parse(chunk))
    response.destroyed = true
    response.emit('close')
  }
  const request = new EventEmitter()
  return {
    lines,
    request: request as unknown as IncomingMessage,
    response: response as unknown as ServerResponse,
  }
}

describe('GuiChannel', () => {
  it('is unavailable without a GUI and forwards commands to the connected one', async () => {
    const events = new EventBus()
    const gui = new GuiChannel(events, 200)
    expect(await gui.send({ kind: 'show', sessionId: 'a0000001', generation: 'g' })).toEqual({
      status: 'unavailable',
    })
    const client = stream()
    gui.attach(client.request, client.response, 60_000)
    expect(gui.connected()).toBe(true)
    const pending = gui.send({ kind: 'title', sessionId: 'a0000001', generation: 'g', label: 'L' })
    const command = client.lines.find((line) => line.type === 'command') as Record<string, string>
    expect(command).toMatchObject({ kind: 'title', sessionId: 'a0000001', label: 'L' })
    expect(gui.result(command.commandId, { applied: true })).toBe(true)
    expect(await pending).toEqual({ status: 'applied' })
    // A result for an answered command is refused.
    expect(gui.result(command.commandId, { applied: true })).toBe(false)
    expect(events.replay(0)?.map((event) => event.type)).toContain('gui.connected')
    gui.close()
  })

  it('keeps mutation verdicts unchanged and times out an unanswered layout read', async () => {
    const gui = new GuiChannel(null, 20)
    const client = stream()
    gui.attach(client.request, client.response, 60_000)
    const mutation = gui.send({ kind: 'show', sessionId: 'a0000001', generation: 'g' })
    const command = client.lines.at(-1) as Record<string, string>
    expect(() => gui.result(command.commandId, { applied: true, layout: {} })).toThrow(
      'unexpected layout',
    )
    gui.result(command.commandId, { applied: true })
    expect(await mutation).toEqual({ status: 'applied' })
    expect(await gui.send({ kind: 'layout' })).toEqual({ status: 'timeout' })
    gui.close()
  })

  it('times out to outcome-uncertain and a second GUI supersedes the first', async () => {
    const gui = new GuiChannel(null, 20)
    const first = stream()
    gui.attach(first.request, first.response, 60_000)
    expect(await gui.send({ kind: 'show', sessionId: 'a0000001', generation: 'g' })).toEqual({
      status: 'timeout',
    })
    const inFlight = gui.send({ kind: 'show', sessionId: 'a0000001', generation: 'g' })
    const second = stream()
    gui.attach(second.request, second.response, 60_000)
    expect(first.lines.at(-1)).toEqual({ type: 'superseded' })
    expect(await inFlight).toEqual({ status: 'timeout' })
    expect(gui.connected()).toBe(true)
    const rejected = gui.send({ kind: 'show', sessionId: 'a0000001', generation: 'g' })
    const command = second.lines.find((line) => line.type === 'command') as Record<string, string>
    gui.result(command.commandId, { applied: false, error: 'window_missing' })
    expect(await rejected).toEqual({ status: 'rejected', error: 'window_missing' })
    gui.close()
    expect(gui.connected()).toBe(false)
  })
})
