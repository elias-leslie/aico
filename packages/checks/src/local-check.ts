// The latest local result for one immutable commit. Publication reads this, never Actions.
import carry from '../data/carry-forward.json' with { type: 'json' }
import { git, gitOk, matches } from './git'
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

export function recordLocalCheck(
  root: string,
  sha: string,
  result: CheckSummary & { scope?: string[] | null },
): LocalCheck {
  // A check scoped to some files proves no more than a quick check does.
  const lane = result.scope ? 'quick' : result.lane
  const prior = localCheck(root, sha)
  // A narrower pass never replaces the whole-tree pass publication relies on.
  if (prior?.passed && prior.lane !== 'quick' && lane === 'quick' && result.passed) return prior
  const value: LocalCheck = {
    kind: 'aico.local-check.v1',
    sha,
    tree: git(root, ['rev-parse', `${sha}^{tree}`]).trim(),
    passed: result.passed,
    lane,
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

export interface Accepted {
  check: LocalCheck
  /** Set when HEAD itself has no record: the ancestor whose acceptance carries forward. */
  carriedFrom?: string
}

const whole = (check: LocalCheck | null): boolean =>
  !!check && check.passed && !check.failed.length && check.lane !== 'quick'

/**
 * The whole-tree (full or acceptance) pass that covers `sha`: its own record, else the nearest
 * ancestor's whose tree differs from `sha` only in non-code paths (docs and roadmap edits).
 * Comparing trees keeps merges honest: a merge that brings in code differs in code.
 */
export function acceptedCheck(root: string, sha: string): Accepted | null {
  const own = localCheck(root, sha)
  // A recorded pass or failure stands; a missing or quick-only record may borrow an ancestor's.
  if (own && (whole(own) || !own.passed)) return { check: own }
  const fallback = own ? { check: own } : null
  if (!gitOk(root, ['rev-parse', '-q', '--verify', `${sha}^{commit}`])) return fallback
  const ancestors = git(root, ['rev-list', `--max-count=${carry.maxAncestors + 1}`, sha])
    .split('\n')
    .filter((id) => id && id !== sha)
  for (const ancestor of ancestors) {
    const check = localCheck(root, ancestor)
    if (!check || !whole(check)) continue
    const changed = git(root, ['diff', '--name-only', '--no-renames', '-z', ancestor, sha])
      .split('\0')
      .filter(Boolean)
    if (changed.every((path) => matches(path, carry.nonCode)))
      return { check, carriedFrom: ancestor }
  }
  return fallback
}

/**
 * Records a carried acceptance on `sha` itself, so the push step (which reads only the exact
 * commit's record) agrees with the carry-forward rule. Never replaces a whole-tree record.
 */
export function recordCarried(root: string, sha: string, accepted: Accepted): void {
  if (!accepted.carriedFrom || !whole(accepted.check)) return
  if (whole(localCheck(root, sha))) return
  const value: LocalCheck & { carried_from: string } = {
    ...accepted.check,
    sha,
    tree: git(root, ['rev-parse', `${sha}^{tree}`]).trim(),
    at: new Date().toISOString(),
    carried_from: accepted.carriedFrom,
  }
  receiptStore(root).put(`publish-${sha}`, value)
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
