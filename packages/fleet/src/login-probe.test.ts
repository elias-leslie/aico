import { expect, it } from 'vitest'
import { probeLoginPage } from './login-probe'

/** A fake site: each URL answers with its HTML, or a redirect to another URL. */
function site(pages: Record<string, string | { redirect: string }>) {
  const asked: string[] = []
  const fetcher = async (url: string) => {
    asked.push(url)
    let at = url
    for (let hop = 0; hop < 5; hop++) {
      const page = pages[at]
      if (page === undefined) return new Response('missing', { status: 404 })
      if (typeof page === 'string') {
        const response = new Response(page, { status: 200 })
        Object.defineProperty(response, 'url', { value: at })
        return response
      }
      at = page.redirect
    }
    throw new Error('loop')
  }
  return { fetcher, asked }
}

it('takes a page with a password field as it is', async () => {
  const { fetcher } = site({
    'https://school.example.test/login/canvas': '<form><input type="password" name="pw"></form>',
  })
  expect(await probeLoginPage('https://school.example.test/login/canvas', fetcher)).toEqual({
    finalUrl: 'https://school.example.test/login/canvas',
    password: true,
    suggestion: null,
    warning: '',
  })
})
it('warns when the site root goes to a portal and suggests the same-site page that has the form', async () => {
  const { fetcher } = site({
    'https://school.example.test/': { redirect: 'https://sso.example.test/portal' },
    'https://sso.example.test/portal': '<a href="https://sso.example.test/help">Help</a>',
    'https://school.example.test/login/canvas': "<input type='password'>",
  })
  const probe = await probeLoginPage('https://school.example.test/', fetcher)
  expect(probe).toMatchObject({
    password: false,
    finalUrl: 'https://sso.example.test/portal',
    suggestion: 'https://school.example.test/login/canvas',
  })
  expect(probe.warning).toBe(
    'No password field at https://school.example.test/ (it went to https://sso.example.test/portal). https://school.example.test/login/canvas has one: save that as the login page.',
  )
})
it('follows the page own sign-in link first', async () => {
  const { fetcher, asked } = site({
    'https://app.example.test/': '<a href="/account/enter">Sign in</a>',
    'https://app.example.test/account/enter': '<input type=password>',
  })
  expect((await probeLoginPage('https://app.example.test/', fetcher)).suggestion).toBe(
    'https://app.example.test/account/enter',
  )
  expect(asked[1]).toBe('https://app.example.test/account/enter')
})
it('says plainly when nothing was found or the site did not answer, and refuses plain http elsewhere', async () => {
  const { fetcher } = site({ 'https://app.example.test/': '<div id="root"></div>' })
  expect((await probeLoginPage('https://app.example.test/', fetcher)).warning).toContain(
    'If the site builds its form with script this is fine',
  )
  const down = await probeLoginPage('https://down.example.test/', async () => {
    throw new Error('ENOTFOUND')
  })
  expect(down.warning).toBe(
    'https://down.example.test/ did not answer, so it could not be checked.',
  )
  expect((await probeLoginPage('http://app.example.test/', fetcher)).warning).toContain('https')
})
it('never suggests another site, and answers a bad address with a warning', async () => {
  const { fetcher } = site({
    'https://school.example.test/': { redirect: 'https://sso.example.test/portal' },
    'https://sso.example.test/portal': '<a href="https://sso.example.test/login">Sign in</a>',
    'https://sso.example.test/login': '<input type="password">',
  })
  expect(await probeLoginPage('https://school.example.test/', fetcher)).toMatchObject({
    suggestion: null,
    password: false,
  })
  expect((await probeLoginPage('http://192.168.1.1/', fetcher)).warning).toBe(
    'The login page must be an https URL',
  )
})
