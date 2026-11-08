'use client'

import { useEffect, useRef, useState } from 'react'
import { characters } from '@/lib/logins'

const MAX_DOTS = 32

/** A hidden value field that shows masked dots and a character count as soon as something is pasted or typed. */
export function SecretField({
  label,
  name = 'value',
}: {
  label: string
  name?: string
}) {
  const [length, setLength] = useState(0),
    input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const form = input.current?.form
    if (!form) return
    const clear = () => setLength(0)
    form.addEventListener('reset', clear)
    return () => form.removeEventListener('reset', clear)
  }, [])
  return (
    <>
      <label>
        {label}
        <input
          ref={input}
          name={name}
          type="password"
          required
          autoComplete="new-password"
          onChange={(e) => setLength([...e.target.value].length)}
        />
      </label>
      {length > 0 && (
        <small role="status">
          <span aria-hidden="true">
            {'•'.repeat(Math.min(length, MAX_DOTS))}
            {length > MAX_DOTS ? '…' : ''}
          </span>{' '}
          {characters(length)}
        </small>
      )}
    </>
  )
}
