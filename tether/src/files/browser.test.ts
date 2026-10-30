import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AccessDenied,
  listDirectory,
  MAX_FILE_SIZE,
  NotFound,
  readFile,
  resolveSafePath,
} from './browser'

let root: string

function write(relative: string, content: string | Buffer = 'x'): string {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

const names = (relative = '') => new Set(listDirectory(root, relative).entries.map((e) => e.name))

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aico-files-')))
})

describe('resolveSafePath', () => {
  it('refuses absolute paths, traversal and forbidden dirs; allows children', () => {
    expect(() => resolveSafePath(root, '/etc/passwd')).toThrow(/absolute paths/)
    expect(() => resolveSafePath(root, '../secret.txt')).toThrow(/\.\./)
    expect(() => resolveSafePath(root, '.git/config')).toThrow(/\.git/)
    expect(() => resolveSafePath(root, 'a\0b')).toThrow(AccessDenied)
    const child = write('src/README.md', 'hello')
    expect(resolveSafePath(root, 'src/README.md')).toBe(child)
    expect(resolveSafePath(root, './src//README.md')).toBe(child)
  })

  it.each([
    '.env',
    '.env.local',
    '.ENV.production',
    'app/.env.local',
    '.envrc',
    '.ssh/id_ed25519',
    '.ssh/config',
    'keys/id_rsa',
    'keys/id_ecdsa.pub',
    'certs/server.pem',
    'certs/SERVER.PEM',
    '.git/config',
  ])('refuses the secret path %s', (relative) => {
    write(relative, 'secret')
    expect(() => readFile(root, relative)).toThrow(/Access denied/)
  })

  it.each([
    ['notes.txt', '.env.local'],
    ['keys', '.ssh'],
    ['cert.txt', 'tls/a.pem'],
  ])('refuses the symlink %s to the secret %s', (link, secret) => {
    if (secret === '.ssh') write('.ssh/id_ed25519', 'secret')
    else write(secret, 'secret')
    symlinkSync(join(root, secret), join(root, link))
    expect(() => resolveSafePath(root, link)).toThrow(/Access denied/)
    if (secret === '.ssh') expect(() => readFile(root, 'keys/id_ed25519')).toThrow(/Access denied/)
  })

  it('refuses a symlink out of the root', () => {
    const outer = mkdtempSync(join(tmpdir(), 'aico-outside-'))
    writeFileSync(join(outer, 'outside.txt'), 'secret')
    symlinkSync(join(outer, 'outside.txt'), join(root, 'link.txt'))
    expect(() => readFile(root, 'link.txt')).toThrow(/escapes pane root/)
  })

  it.each([
    '.config/gh/hosts.yml',
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.aws/credentials',
    '.docker/config.json',
    '.kube/config',
    '.gnupg/private-keys-v1.d/key',
    '.local/share/keyrings/login.keyring',
    '.netrc',
    '.pgpass',
    '.npmrc',
    '.pypirc',
    '.git-credentials',
    '.bash_history',
    'certs/tls.KEY',
    'certs/client.p12',
    'certs/client.pfx',
    'gcloud/credentials.json',
    'svc.credentials.json',
    'app/auth.json',
  ])('a home-rooted tab refuses %s', (relative) => {
    write(relative, 'secret')
    expect(() => readFile(root, relative)).toThrow(/Access denied/)
  })
})

describe('listDirectory', () => {
  it('hides secret entries and keeps ordinary files', () => {
    for (const name of [
      '.env.local',
      'server.pem',
      'id_rsa',
      'id_utils.py',
      'README.md',
      'environment.md',
    ])
      write(name)
    expect(names()).toEqual(new Set(['id_utils.py', 'README.md', 'environment.md']))
    expect(readFile(root, 'id_utils.py').content).toBe('x')
  })

  it.each(['.config', '.config/gh', '.aws', 'src/.cache'])(
    'refuses to list the hidden directory %s',
    (relative) => {
      mkdirSync(join(root, relative, 'inner'), { recursive: true })
      expect(() => listDirectory(root, relative)).toThrow(/Access denied/)
    },
  )

  it('refuses symlinks into a hidden directory, keeps ordinary ones', () => {
    write('.config/gh/hosts.yml', 'oauth_token: secret')
    symlinkSync(join(root, '.config/gh/hosts.yml'), join(root, 'gh-hosts.yml'))
    symlinkSync(join(root, '.config/gh'), join(root, 'ghdir'))
    expect(() => readFile(root, 'gh-hosts.yml')).toThrow(/Access denied/)
    expect(() => listDirectory(root, 'ghdir')).toThrow(/Access denied/)
    mkdirSync(join(root, 'src'))
    symlinkSync(join(root, 'src'), join(root, 'src-link'))
    expect(names()).toEqual(new Set(['src', 'src-link']))
  })

  it('keeps project dotfiles and ordinary sources readable', () => {
    const files = ['.gitignore', '.prettierrc', 'credentials_test.py', 'auth.py', 'keyboard.ts']
    for (const name of files) write(name)
    for (const name of files) expect(readFile(root, name).content).toBe('x')
    expect(listDirectory(root, '').total).toBe(5)
  })

  it('lists directories first by lowercase name, skips build dirs, counts children', () => {
    write('b.txt', 'hello')
    write('A.md')
    write('zdir/one.ts')
    write('zdir/node_modules/x.js')
    write('zdir/.hidden/y')
    write('node_modules/pkg/index.js')
    write('dist/out.js')
    const listing = listDirectory(root)
    expect(listing.entries).toEqual([
      { name: 'zdir', path: 'zdir', is_directory: true, children_count: 1 },
      { name: 'A.md', path: 'A.md', is_directory: false, size: 1, extension: '.md' },
      { name: 'b.txt', path: 'b.txt', is_directory: false, size: 5, extension: '.txt' },
    ])
    expect(listing).toMatchObject({ path: '', total: 3 })
    expect(listDirectory(root, 'zdir').entries.map((entry) => entry.path)).toEqual(['zdir/one.ts'])
    expect(() => listDirectory(root, 'b.txt')).toThrow(NotFound)
  })
})

describe('readFile', () => {
  it('reads text as Python text mode does and names its language', () => {
    write('Dockerfile', 'FROM x\r\nRUN y\rEND')
    expect(readFile(root, 'Dockerfile')).toEqual({
      path: 'Dockerfile',
      name: 'Dockerfile',
      content: 'FROM x\nRUN y\nEND',
      size: 17,
      lines: 3,
      extension: null,
      is_binary: false,
      language: 'dockerfile',
      truncated: false,
    })
    write('bad.py', Buffer.from([0x61, 0xff, 0x0a]))
    expect(readFile(root, 'bad.py')).toMatchObject({
      content: 'a�\n',
      lines: 1,
      language: 'python',
    })
  })

  it('marks binaries by extension or NUL and truncates big text', () => {
    write('image.png', 'not really')
    write('blob.txt', Buffer.from([0x61, 0x00, 0x62]))
    expect(readFile(root, 'image.png')).toMatchObject({ is_binary: true, content: null, lines: 0 })
    expect(readFile(root, 'blob.txt')).toMatchObject({ is_binary: true, content: null })
    write('big.txt', 'a'.repeat(MAX_FILE_SIZE + 10))
    const big = readFile(root, 'big.txt')
    expect(big).toMatchObject({ truncated: true, size: MAX_FILE_SIZE + 10, lines: 1 })
    expect(big.content?.length).toBe(MAX_FILE_SIZE)
    mkdirSync(join(root, 'folder'))
    expect(() => readFile(root, 'folder')).toThrow(/Not a file: folder/)
    expect(() => readFile(root, 'missing.txt')).toThrow(NotFound)
  })
})
