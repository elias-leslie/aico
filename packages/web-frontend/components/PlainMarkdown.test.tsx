import { render } from '@testing-library/react'
import { expect, it } from 'vitest'
import { PlainMarkdown } from './PlainMarkdown'

it('drops markup characters and keeps the words', () => {
  const { container } = render(
    <PlainMarkdown
      text={'# Title\n**Why:** a * b and 2*3 stay.\n\n* one\n- two'}
    />,
  )
  expect(container.textContent).toBe('TitleWhy: a * b and 2*3 stay.onetwo')
  expect(container.querySelectorAll('li')).toHaveLength(2)
  expect(container.querySelector('strong')).not.toBeNull()
})

it('never turns text into HTML', () => {
  const { container } = render(
    <PlainMarkdown text={'<img src=x onerror=1> `<b>`'} />,
  )
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('code')?.textContent).toBe('<b>')
})

it('shows fenced code as a block and numbers an ordered list', () => {
  const { container } = render(
    <PlainMarkdown
      text={'Run:\n\n```sh\nst check --quick\nst commit\n```\n\n1. one\n2. two'}
    />,
  )
  expect(container.textContent).not.toContain('```')
  expect(container.querySelector('pre code')?.textContent).toBe(
    'st check --quick\nst commit',
  )
  expect(container.querySelectorAll('ol li')).toHaveLength(2)
})
