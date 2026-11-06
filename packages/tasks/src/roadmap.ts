// ROADMAP.md: a project's checked-in plan. The Projects page and the commit check read it with
// this one parser (docs/plans/projects-page/plan.md has the format).
//
//   # Name
//   One paragraph: what the project is.
//   ## Now | ## Next | ## Later
//   - Item in plain words (plan: docs/plans/x/plan.md) (blocked: reason)
//
// Nothing is dropped: a line that is not a "- " item, a section other than these three, and
// text before the first section that is not the name or the overview come back as raw lines.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ROADMAP_FILE = 'ROADMAP.md'
const ROADMAP_SECTIONS = ['now', 'next', 'later'] as const
type RoadmapSection = (typeof ROADMAP_SECTIONS)[number]

export interface RoadmapItem {
  text: string
  plan?: string
  blocked?: string
  /** The line was not a "- " item; `text` is the line as written. */
  raw?: true
}

export interface RoadmapProblem {
  /** 1-based line in the file. */
  line: number
  text: string
  why: string
}

export interface Roadmap {
  name: string | null
  overview: string | null
  now: RoadmapItem[]
  next: RoadmapItem[]
  later: RoadmapItem[]
  /** Lines of sections other than Now, Next and Later, as written (heading included). */
  other: string[]
  /** What does not follow the format; the page shows these lines raw and the commit check names them. */
  problems: RoadmapProblem[]
}

const SUFFIX = /\s*\((plan|blocked):\s*([^()]*?)\s*\)\s*$/i
const SECTION = /^##\s+(.*?)\s*#*\s*$/
const ITEM = /^[-*]\s+(.*\S)\s*$/

function item(body: string): RoadmapItem {
  let text = body
  const out: RoadmapItem = { text }
  for (;;) {
    const match = SUFFIX.exec(text)
    if (!match) break
    const key = (match[1] as string).toLowerCase() as 'plan' | 'blocked'
    if (out[key] === undefined) out[key] = match[2] as string
    text = text.slice(0, match.index)
  }
  out.text = text.trim()
  return out
}

/** Parses ROADMAP.md text. Never throws. */
export function parseRoadmap(source: string): Roadmap {
  const roadmap: Roadmap = {
    name: null,
    overview: null,
    now: [],
    next: [],
    later: [],
    other: [],
    problems: [],
  }
  const overview: string[] = []
  let section: RoadmapSection | 'other' | null = null
  const lines = source.replace(/^﻿/, '').split(/\r?\n/)
  lines.forEach((full, index) => {
    const line = full.trimEnd()
    const at = index + 1
    const heading = SECTION.exec(line)
    if (heading) {
      const word = (heading[1] as string).toLowerCase()
      if ((ROADMAP_SECTIONS as readonly string[]).includes(word)) section = word as RoadmapSection
      else {
        section = 'other'
        roadmap.other.push(line)
        roadmap.problems.push({ line: at, text: line, why: 'only Now, Next and Later sections' })
      }
      return
    }
    if (/^#\s+/.test(line) && !/^##/.test(line)) {
      if (roadmap.name === null && section === null) {
        roadmap.name = line.replace(/^#\s+/, '').trim() || null
        return
      }
    }
    if (!line.trim()) {
      if (section === null && overview.length && overview[overview.length - 1] !== '')
        overview.push('')
      return
    }
    if (section === null) {
      if (roadmap.name === null) {
        roadmap.problems.push({ line: at, text: line, why: 'text before the # title' })
        return
      }
      overview.push(line.trim())
      return
    }
    if (section === 'other') {
      roadmap.other.push(line)
      return
    }
    const bullet = ITEM.exec(line)
    if (bullet) {
      const parsed = item(bullet[1] as string)
      if (parsed.text) roadmap[section].push(parsed)
      else roadmap.problems.push({ line: at, text: line, why: 'an item with no text' })
      return
    }
    // A wrapped continuation of the previous item (indented) is part of it.
    const previous = roadmap[section][roadmap[section].length - 1]
    if (/^\s+\S/.test(full) && previous && !previous.raw) {
      const extended = item(`${previous.text} ${line.trim()}`)
      previous.text = extended.text
      if (previous.plan === undefined && extended.plan !== undefined) previous.plan = extended.plan
      if (previous.blocked === undefined && extended.blocked !== undefined)
        previous.blocked = extended.blocked
      return
    }
    roadmap[section].push({ text: line.trim(), raw: true })
    roadmap.problems.push({ line: at, text: line, why: 'not a "- " item' })
  })
  const paragraph = overview.join('\n').trim()
  roadmap.overview = paragraph ? paragraph.replace(/\n+/g, ' ') : null
  return roadmap
}

/** The project's ROADMAP.md parsed, or null when the file is missing or unreadable. */
export function readRoadmap(root: string): Roadmap | null {
  let text: string
  try {
    text = readFileSync(join(root, ROADMAP_FILE), 'utf8')
  } catch {
    return null
  }
  return parseRoadmap(text)
}
