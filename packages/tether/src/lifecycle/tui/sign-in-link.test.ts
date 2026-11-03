import { describe, expect, it } from 'vitest'
import { extractSignInLink, SIGN_IN_TITLE, signInToolOf } from './sign-in-link'

// agy 1.4.12's sign-in screen at 100 columns, as `tmux capture-pane -p` prints
// it: the URL is hard-wrapped at the pane width after a one-space margin. The
// challenge and state are made up.
const CLIENT = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
const URL_TEXT =
  'https://accounts.google.com/o/oauth2/auth?access_type=offline' +
  `&client_id=${CLIENT}&code_challenge=Zk3Fake0Challenge0ForTests0Only0aBcDeFgHiJkL` +
  '&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback' +
  '&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+openid&state=fakeState123abcXYZ'

function wrap(text: string, width: number, margin = ' '): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += width) out.push(margin + text.slice(i, i + width))
  return out
}

const intro = [
  '     ▄▀▀▄',
  '    ▀▀▀▀▀▀',
  '',
  ' Your browser should open automatically. If not:',
  '',
]
const outro = [
  '',
  " If you aren't automatically redirected, paste the authorization code below:",
  '',
  ' authorization code...',
  '',
  '  shift+up/down Navigate',
]

describe('extractSignInLink', () => {
  it('joins a URL hard-wrapped at the pane width into one link', () => {
    const screen = [...intro, ...wrap(URL_TEXT, 99), ...outro].join('\n')
    expect(extractSignInLink(screen, 'accounts.google.com')).toBe(URL_TEXT)
  })

  it('joins a URL wrapped at a narrow pane, with a short last line', () => {
    const screen = [...intro, ...wrap(URL_TEXT, 58), ...outro].join('\n')
    expect(extractSignInLink(screen, 'accounts.google.com')).toBe(URL_TEXT)
  })

  it('joins a URL inside a box, dropping its borders and padding', () => {
    const inner = 70
    const rows = wrap(URL_TEXT, inner, '').map((row) => `│ ${row.padEnd(inner)} │`)
    const bar = '─'.repeat(inner + 2)
    const screen = [`╭${bar}╮`, ...rows, `╰${bar}╯`].join('\n')
    expect(extractSignInLink(screen, 'accounts.google.com')).toBe(URL_TEXT)
  })

  it('does not take a word after the URL as part of it', () => {
    const lines = wrap(URL_TEXT, 99)
    const screen = [...intro, ...lines, 'Done', ...outro].join('\n')
    const last = lines[lines.length - 1].length
    // The last line is shorter than the others, so what follows is not a continuation.
    expect(last).toBeLessThan(100)
    expect(extractSignInLink(screen, 'accounts.google.com')).toBe(URL_TEXT)
  })

  it('finds nothing before the URL is printed, or on another host', () => {
    expect(
      extractSignInLink('Select login method:\n > 1. Google OAuth', 'accounts.google.com'),
    ).toBeNull()
    expect(extractSignInLink(' https://antigravity.google/terms', 'accounts.google.com')).toBeNull()
    expect(
      extractSignInLink(' https://accounts.google.com.evil.example/x', 'accounts.google.com'),
    ).toBeNull()
  })

  it('takes the newest link when two are on screen', () => {
    const older = 'https://accounts.google.com/o/oauth2/auth?state=old'
    const newer = 'https://accounts.google.com/o/oauth2/auth?state=new'
    expect(extractSignInLink(` ${older}\n\n ${newer}\n`, 'accounts.google.com')).toBe(newer)
  })
})

describe('signInToolOf', () => {
  it('reads the tool off a sign-in session title', () => {
    expect(signInToolOf(`${SIGN_IN_TITLE}agy`)).toBe('agy')
    expect(signInToolOf('Sign out: agy')).toBeNull()
    expect(signInToolOf(null)).toBeNull()
  })
})
