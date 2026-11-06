// The roadmap part of the startup brief: the project's overview line plus a few Now and Next items,
// from ROADMAP.md. No file, no lines.

import { type Roadmap, type RoadmapItem, readRoadmap } from './roadmap'

const SHOWN = 3
const OVERVIEW_CHARS = 220

function itemLine(item: RoadmapItem): string {
  const plan = item.plan ? ` (plan: ${item.plan})` : ''
  const blocked = item.blocked ? ` (blocked: ${item.blocked})` : ''
  return `- ${item.text}${plan}${blocked}`
}

function section(name: string, items: RoadmapItem[]): string[] {
  if (items.length === 0) return [`${name}: nothing listed`]
  const lines = [`${name}:`, ...items.slice(0, SHOWN).map(itemLine)]
  if (items.length > SHOWN) lines.push(`- +${items.length - SHOWN} more in ROADMAP.md`)
  return lines
}

function roadmapBriefLines(roadmap: Roadmap): string[] {
  const overview = roadmap.overview
    ? roadmap.overview.length > OVERVIEW_CHARS
      ? `${roadmap.overview.slice(0, OVERVIEW_CHARS - 3).trimEnd()}...`
      : roadmap.overview
    : null
  return [
    `Project roadmap (ROADMAP.md${roadmap.name ? `, ${roadmap.name}` : ''}):`,
    ...(overview ? [overview] : []),
    ...section('Now', roadmap.now),
    ...section('Next', roadmap.next),
  ]
}

/** The roadmap lines for the project rooted at `root`; empty without a ROADMAP.md. */
export function roadmapBrief(root: string | null): string[] {
  const roadmap = root ? readRoadmap(root) : null
  return roadmap ? roadmapBriefLines(roadmap) : []
}
