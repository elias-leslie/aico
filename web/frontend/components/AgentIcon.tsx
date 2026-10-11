'use client'

import { type JSX, memo } from 'react'

/**
 * Marks for agent tool slugs (and the plain shell).
 * Claude Code, Codex, Antigravity and Pi use each tool's published mark,
 * drawn monochrome so it can be tinted with the tool's color.
 * Other slugs keep an original suggestive mark or the generic fallback.
 */

interface AgentIconProps {
  slug: string
  size?: number
  color?: string
  className?: string
}

type MarkProps = { size: number; color: string }

/** Claude Code — Claude spark */
function ClaudeIcon({ size, color }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  )
}

/** Codex — cloud with a >_ prompt cutout */
function CodexIcon({ size, color }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  )
}

/** Antigravity — arch mark */
function AntigravityIcon({ size, color }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="12 13 88 88"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z" />
    </svg>
  )
}

/** Pi — block pi mark */
function PiIcon({ size, color }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-28 -28 616 616"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M420 280H280V140H0V0H420ZM560 560H420V280H560ZM140 560H0V140H140V280H280V420H140Z" />
    </svg>
  )
}

/** Shell — filled terminal tile with a >_ prompt */
function ShellIcon({ size, color }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        d="M6 3h12a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm.9 6.2a1 1 0 0 0-.1 1.4L8.7 12.5l-1.9 1.9a1 1 0 1 0 1.4 1.4l2.6-2.6a1 1 0 0 0 0-1.4L8.2 9.2a1 1 0 0 0-1.3 0ZM12.5 14.5a1 1 0 1 0 0 2h4.5a1 1 0 1 0 0-2Z"
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

const ICON_MAP: Record<string, (props: MarkProps) => JSX.Element> = {
  agy: AntigravityIcon,
  'claude-code': ClaudeIcon,
  codex: CodexIcon,
  gemini: GeminiIcon,
  hermes: HermesIcon,
  opencode: OpenCodeIcon,
  pi: PiIcon,
  shell: ShellIcon,
}

/** Default brand-suggestive colors per agent slug.
 *  Spectrally distinct on a dark a-term canvas. */
export const AGENT_DEFAULT_COLORS: Record<string, string> = {
  agy: '#3186FF', // Antigravity blue
  'claude-code': '#D97757', // Claude terracotta
  codex: '#9B8CFF', // Codex lavender
  gemini: '#A78BFA', // Soft violet — dual/twin energy
  hermes: '#F59E0B', // Amber — courier / signal energy
  opencode: '#60A5FA', // Cerulean blue — open sky
  pi: '#C16A8A', // Pi rose
  shell: '#8A8F98', // Neutral gray — plain terminal
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
      aria-hidden="true"
      data-agent-icon={slug}
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
