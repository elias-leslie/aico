// The latest local result for one immutable commit. Publication reads this, never Actions.
import { git } from './git'
import { receiptStore } from './run'
import type { CheckSummary } from './status'

export interface LocalCheck {
  kind: 'aico.local-check.v1'
  sha: string
  tree: string
  passed: boolean
  lane: CheckSummary['lane']
  failed: string[]
  at: string
}

export function recordLocalCheck(root: string, sha: string, result: CheckSummary): LocalCheck {
  const value: LocalCheck = {
    kind: 'aico.local-check.v1',
    sha,
    tree: git(root, ['rev-parse', `${sha}^{tree}`]).trim(),
    passed: result.passed,
    lane: result.lane,
    failed: result.results
      .filter((r) => r.required && !['pass', 'skip'].includes(r.state))
      .map((r) => r.id),
    at: new Date().toISOString(),
  }
  receiptStore(root).put(`publish-${sha}`, value)
  return value
}

export function localCheck(root: string, sha: string): LocalCheck | null {
  const value = receiptStore(root).get<LocalCheck>(`publish-${sha}`)
  if (
    value?.kind !== 'aico.local-check.v1' ||
    value.sha !== sha ||
    value.tree !== git(root, ['rev-parse', `${sha}^{tree}`]).trim() ||
    typeof value.passed !== 'boolean' ||
    !Array.isArray(value.failed) ||
    !value.failed.every((id) => typeof id === 'string') ||
    (value.passed && value.failed.length)
  )
    return null
  return value
}

/** Publishing can lose its proof without changing the outcome of a local check or commit. */
export function noteLocalCheck(
  root: string,
  sha: string,
  result: CheckSummary,
  out: (line: string) => void,
): void {
  try {
    recordLocalCheck(root, sha, result)
  } catch {
    out('Publication check could not be recorded; the local result is unchanged.')
  }
}
