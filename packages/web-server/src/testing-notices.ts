// Test stand-ins for the Notifier that notices go to (notice.ts NoticeSink).

import type { NoticeSink } from './notice'

/** Takes every notice and every resolve and keeps them for the test to read. */
export function recorder(): {
  sink: NoticeSink
  received: unknown[]
  resolved: [string, string, string][]
} {
  const received: unknown[] = []
  const resolved: [string, string, string][] = []
  return {
    received,
    resolved,
    sink: {
      receive: (notice) => received.push(notice),
      resolve: async (source, key, text) => {
        resolved.push([source, key, text])
      },
    },
  }
}

/** Takes notices and drops them. */
export const QUIET: NoticeSink = recorder().sink
