// The ROADMAP.md format check the quick check runs in any repo that has one. It uses the same parser
// as the Projects page (@aico/tasks), so what the page shows and what a commit accepts never differ.
// The answer is one line: the first problem, its line number and how many more there are.

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { parseRoadmap, ROADMAP_FILE } from '@aico/tasks'
import type { StepResult } from './run'

const MALFORMED_SUFFIX = /\((?:plan|blocked)\b/i

interface Problem {
  line: number
  message: string
}

/** What is wrong with a ROADMAP.md text; `exists` says whether a plan path is in the repo. */
export function roadmapProblems(text: string, exists: (path: string) => boolean): Problem[] {
  const roadmap = parseRoadmap(text)
  const problems: Problem[] = roadmap.problems.map((p) => ({
    line: p.line,
    message: `${p.why}: ${p.text.trim().slice(0, 60)}`,
  }))
  if (roadmap.name === null) problems.push({ line: 1, message: 'missing the "# Name" title' })
  else if (roadmap.overview === null)
    problems.push({ line: 2, message: 'missing the overview paragraph under the title' })
  for (const item of [...roadmap.now, ...roadmap.next, ...roadmap.later]) {
    if (item.raw) continue
    const line = lineOf(text, item.text)
    if (MALFORMED_SUFFIX.test(item.text) || item.plan === '' || item.blocked === '')
      problems.push({
        line,
        message: `malformed (plan: PATH) or (blocked: REASON) suffix: ${item.text.slice(0, 60)}`,
      })
    else if (
      item.plan &&
      (isAbsolute(item.plan) || normalize(item.plan).startsWith('..') || !exists(item.plan))
    )
      problems.push({ line, message: `plan path ${item.plan} does not exist in the repo` })
  }
  return problems.sort((a, b) => a.line - b.line)
}

function lineOf(text: string, itemText: string): number {
  const index = text.split(/\r?\n/).findIndex((line) => line.includes(itemText))
  return index < 0 ? 1 : index + 1
}

/** The failing `roadmap` step when the repo's ROADMAP.md breaks the format; null when fine or absent. */
export function roadmapStep(root: string, scope: string[] | null): StepResult | null {
  if (scope && !scope.includes(ROADMAP_FILE)) return null
  let text: string
  try {
    text = readFileSync(join(root, ROADMAP_FILE), 'utf8')
  } catch {
    return null
  }
  const problems = roadmapProblems(text, (path) => existsSync(join(root, path)))
  if (!problems.length) return null
  const [first] = problems
  const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : ''
  return {
    id: 'roadmap',
    state: 'fail',
    ms: 0,
    required: true,
    hint: `${ROADMAP_FILE}:${first.line}: ${first.message}${more}`,
  }
}
