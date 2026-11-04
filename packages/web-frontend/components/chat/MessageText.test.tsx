import { render } from '@testing-library/react'
import { expect, it } from 'vitest'
import { MessageText } from './MessageText'

it('renders emphasis without changing code or interpreting HTML', () => {
  const { container } = render(
    <MessageText
      text={
        '**First** and *second* with `**literal**`.\n```txt\n**code**\n```\n<img src=x onerror=alert(1)>'
      }
    />,
  )
  expect(container.querySelector('strong')).toHaveTextContent('First')
  expect(container.querySelector('em')).toHaveTextContent('second')
  expect(container.querySelector('code')).toHaveTextContent('**literal**')
  expect(container.querySelector('pre')).toHaveTextContent('**code**')
  expect(container.querySelector('img')).toBeNull()
  expect(container).toHaveTextContent('<img src=x onerror=alert(1)>')
})

it.each(['**First', '*First', '`First'])(
  'keeps every character of an unfinished streamed marker: %s',
  (text) => {
    const { container } = render(<MessageText text={text} />)
    expect(container.textContent).toBe(text)
  },
)

it('keeps an open code block readable while the reply is streaming or stopped', () => {
  const { container } = render(<MessageText text={'```ts\nconst value = 1'} />)
  expect(container.querySelector('pre code')).toHaveTextContent(
    'const value = 1',
  )
  expect(container).not.toHaveTextContent('```ts')
})
