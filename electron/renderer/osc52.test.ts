import { describe, expect, it } from 'vitest'
import { osc52Text } from './osc52'

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

describe('osc52Text', () => {
  it('decodes a clipboard write, UTF-8 included', () => {
    expect(osc52Text(`c;${b64('https://192.168.86.39:8006')}`)).toBe('https://192.168.86.39:8006')
    expect(osc52Text(`;${b64('héllo ✓')}`)).toBe('héllo ✓')
  })

  it('ignores queries, empty and malformed payloads', () => {
    expect(osc52Text('c;?')).toBeNull()
    expect(osc52Text('c;')).toBeNull()
    expect(osc52Text('nosemicolon')).toBeNull()
    expect(osc52Text('c;!!!not-base64')).toBeNull()
  })
})
