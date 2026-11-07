import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// One run for the whole repo: every package under packages/ is a project with
// its own vitest.config.ts. Each project also gets the load-proof defaults of
// vitest.setup.ts and the longer timeouts below: the gate runs on a shared,
// often busy machine, and a test that passes alone must not fail because the
// run was slow. A test that is really stuck still fails, just later.
const here = fileURLToPath(new URL('.', import.meta.url))

const projects = readdirSync(`${here}packages`)
  .filter((name) => existsSync(`${here}packages/${name}/vitest.config.ts`))
  .sort()
  .map((name) => ({
    extends: `${here}packages/${name}/vitest.config.ts`,
    root: `${here}packages/${name}`,
    test: {
      // Throwaway test repos use a plain identity and no global git hooks: the owner's credential
      // guard costs about 0.3 s per commit, and tests make hundreds.
      env: { GIT_CONFIG_GLOBAL: `${here}vitest.gitconfig` },
      testTimeout: 60_000,
      hookTimeout: 60_000,
      setupFiles: [`${here}vitest.load-proof.ts`],
    },
  }))

export default defineConfig({ test: { projects } })
