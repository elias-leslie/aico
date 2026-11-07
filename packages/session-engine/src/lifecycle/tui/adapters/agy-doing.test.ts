import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agyDoing, stepsDoing, toolCallDoing } from './agy-doing'

// A step payload as agy writes it: protobuf bytes around the call id, the tool's name and its arguments as JSON.
const payload = (name: string, args: object) =>
  Buffer.concat([
    Buffer.from([0x0a, 0x1a]),
    Buffer.from('call_3516449928796323800'),
    Buffer.from([0x12, name.length]),
    Buffer.from(name),
    Buffer.from([0x1a, 0x7f]),
    Buffer.from(JSON.stringify(args)),
    Buffer.from([0x3a, 0x82, 0x0b, 0x12, 0xff]),
  ])

describe('agy doing now', () => {
  it('reads the line agy wrote for the tool call, else its summary, else the tool name', () => {
    expect(
      toolCallDoing(
        payload('run_command', {
          CommandLine: 'st ready',
          toolAction: 'Running st ready',
          toolSummary: 'Check ready tasks',
        }),
      ),
    ).toBe('Running st ready')
    expect(toolCallDoing(payload('grep_search', { Query: 'x', toolSummary: 'grep x' }))).toBe(
      'grep x',
    )
    expect(toolCallDoing(payload('find_by_name', { Pattern: '*' }))).toBe('Using find_by_name')
    expect(toolCallDoing(Buffer.from('no call here'))).toBeNull()
  })

  it('takes the newest tool call, or nothing once the owner spoke after it', () => {
    const step = (step_type: number, name: string, action: string) => ({
      step_type,
      step_payload: payload(name, { toolAction: action }),
    })
    expect(
      stepsDoing([step(132, 'view_file', 'Viewing the plan'), step(15, 'run_command', 'Older')]),
    ).toBe('Viewing the plan')
    expect(
      stepsDoing([
        { step_type: 14, step_payload: null },
        step(132, 'view_file', 'Viewing the plan'),
      ]),
    ).toBeNull()
    expect(stepsDoing([])).toBeNull()
  })

  describe('from the database', () => {
    let home: string
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'agy-'))
      mkdirSync(join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true })
    })
    afterEach(() => rmSync(home, { recursive: true, force: true }))

    it('reads the newest steps, and looks again only when the file changed', () => {
      const id = 'b3458e85-d9be-42e1-b91a-b58e2503c154'
      const path = join(home, '.gemini', 'antigravity-cli', 'conversations', `${id}.db`)
      writeFileSync(path, 'a')
      let steps: { step_type: number; step_payload: Uint8Array | null }[] = [
        { step_type: 14, step_payload: Buffer.from('prompt') },
      ]
      let reads = 0
      const read = () => {
        reads += 1
        return steps
      }
      expect(agyDoing(id, home, read)).toBeNull()
      expect(agyDoing(id, home, read)).toBeNull()
      expect(reads).toBe(1)
      steps = [
        {
          step_type: 132,
          step_payload: payload('write_to_file', { toolAction: 'Writing the notes file' }),
        },
        ...steps,
      ]
      appendFileSync(path, 'more')
      expect(agyDoing(id, home, read)).toBe('Writing the notes file')
      expect(reads).toBe(2)
      expect(agyDoing(null, home, read)).toBeNull()
      expect(agyDoing('../escape', home, read)).toBeNull()
      expect(reads).toBe(2)
    })
  })
})
