import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'

// findBy*/waitFor wait up to 1 s by default; a busy machine needs more. A met wait returns at once.
configure({ asyncUtilTimeout: 15_000 })
