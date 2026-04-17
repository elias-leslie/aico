'use client'

import { memo } from 'react'

/**
 * Custom SVG icons for known agent tool slugs.
 * These are original designs — not trademarked logos.
 * Each icon is suggestive of the agent's identity without copying official marks.
 */

interface AgentIconProps {
  slug: string
  size?: number
  color?: string
  className?: string
}

/** Claude — abstract angular "C" with an inner spark */
function ClaudeIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M15.5 4.5C13.8 3.5 11.7 3.2 9.8 3.8C6 5 3.8 9 5 12.8C6.2 16.6 10.2 18.8 14 17.6C15.9 17 17.4 15.6 18.2 13.8"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12 8L13.5 11.5L17 13L13.5 14.5L12 18L10.5 14.5L7 13L10.5 11.5L12 8Z"
        fill={color}
        opacity="0.9"
      />
    </svg>
  )
}

/** Codex — stylized code brackets with a cursor line */
function CodexIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 6L3 12L8 18"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 6L21 12L16 18"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="12"
        y1="7"
        x2="12"
        y2="17"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.6"
      />
    </svg>
  )
}

/** Gemini — twin faceted diamonds */
function GeminiIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8.5 4L5 12L8.5 20"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.5 4L19 12L15.5 20"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="8" r="1.5" fill={color} opacity="0.8" />
      <circle cx="12" cy="16" r="1.5" fill={color} opacity="0.8" />
      <line
        x1="12"
        y1="9.5"
        x2="12"
        y2="14.5"
        stroke={color}
        strokeWidth="1"
        opacity="0.4"
      />
    </svg>
  )
}

/** OpenCode — open a-term frame with blinking prompt */
function OpenCodeIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="3"
        stroke={color}
        strokeWidth="1.5"
        opacity="0.7"
      />
      <path
        d="M7 12L10 9.5L7 7"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="11"
        y1="12"
        x2="16"
        y2="12"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.7"
      />
      <line
        x1="7"
        y1="16"
        x2="17"
        y2="16"
        stroke={color}
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.3"
      />
    </svg>
  )
}

/** Hermes — H frame with courier speed lines */
function HermesIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <line
        x1="8"
        y1="5"
        x2="8"
        y2="19"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="16"
        y1="5"
        x2="16"
        y2="19"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="8"
        y1="12"
        x2="16"
        y2="12"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M3.5 9H6.5"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.75"
      />
      <path
        d="M2.5 12H5.5"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M3.5 15H6.5"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.35"
      />
    </svg>
  )
}

/** Fallback — generic AI/bot indicator */
function GenericAgentIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle
        cx="12"
        cy="12"
        r="8"
        stroke={color}
        strokeWidth="1.5"
        opacity="0.5"
      />
      <circle cx="9" cy="10.5" r="1.5" fill={color} />
      <circle cx="15" cy="10.5" r="1.5" fill={color} />
      <path
        d="M9 15C9.8 16.2 11 17 12 17C13 17 14.2 16.2 15 15"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

const ICON_MAP: Record<string, typeof ClaudeIcon> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  gemini: GeminiIcon,
  hermes: HermesIcon,
  opencode: OpenCodeIcon,
}

/** Default brand-suggestive colors per agent slug.
 *  Spectrally distinct on a dark a-term canvas. */
export const AGENT_DEFAULT_COLORS: Record<string, string> = {
  claude: '#D4845A', // Burnt sienna — warm, organic
  codex: '#22D3EE', // Electric cyan — digital, code-native
  gemini: '#A78BFA', // Soft violet — dual/twin energy
  hermes: '#F59E0B', // Amber — courier / signal energy
  opencode: '#60A5FA', // Cerulean blue — open sky
}

/** Resolve display color for an agent tool.
 *  Treats the generic phosphor green (#00FF9F) as "no custom color set". */
export function getAgentColor(slug: string, toolColor?: string | null): string {
  if (!toolColor || toolColor.toUpperCase() === '#00FF9F') {
    return AGENT_DEFAULT_COLORS[slug] || 'var(--term-accent)'
  }
  return toolColor
}

export const AgentIcon = memo(function AgentIcon({
  slug,
  size = 16,
  color = 'currentColor',
  className,
}: AgentIconProps) {
  const IconComponent = ICON_MAP[slug] ?? GenericAgentIcon
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <IconComponent size={size} color={color} />
    </span>
  )
})
