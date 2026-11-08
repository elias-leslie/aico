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

it('shows a markdown link as its label, never as [label](path)', () => {
  const opened: string[] = []
  const { container, getByRole } = render(
    <PlainMarkdown
      text={
        'See [the report](/srv/x/report.md) and [docs](https://example.com/a).'
      }
      onOpenPath={(path) => opened.push(path)}
    />,
  )
  expect(container.textContent).toBe('See the report and docs.')
  getByRole('button', { name: 'the report' }).click()
  expect(opened).toEqual(['/srv/x/report.md'])
  const web = getByRole('link', { name: 'docs' })
  expect(web.getAttribute('href')).toBe('https://example.com/a')
  expect(web.getAttribute('rel')).toContain('noopener')
})

it('names a local file when the page cannot open it', () => {
  const { container } = render(
    <PlainMarkdown text={'[report](/srv/x/report.md)'} />,
  )
  expect(container.textContent).toBe('report')
  expect(container.querySelector('button')).toBeNull()
})

it('shows web addresses and Aico paths as buttons only where asked, and leaves file paths alone', () => {
  const text =
    'See https://example.com/a. Then /workbench?tab=designs&design=1, and /srv/workspaces/x or `/workbench`.'
  const plain = render(<PlainMarkdown text={text} />)
  expect(plain.container.querySelector('a')).toBeNull()
  plain.unmount()
  const opened: string[] = []
  const { container } = render(
    <PlainMarkdown
      text={text}
      buttons
      onOpenApp={(path) => opened.push(path)}
    />,
  )
  const links = [...container.querySelectorAll('a')]
  expect(links.map((a) => a.textContent)).toEqual([
    'example.com/a',
    'Open Designs',
  ])
  expect(links.every((a) => a.classList.contains('lantern-btn'))).toBe(true)
  expect(container.textContent).toContain('/srv/workspaces/x')
  expect(container.querySelector('code')?.textContent).toBe('/workbench')
  links[1].click()
  expect(opened).toEqual(['/workbench?tab=designs&design=1'])
})
