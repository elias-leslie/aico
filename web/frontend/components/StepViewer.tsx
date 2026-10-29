'use client'

import { ChevronLeft } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'
import type { RunMember } from 'tether/teams'
import { AgentHubChat } from './AgentHubChat'
import { AgentIcon, getAgentColor } from './AgentIcon'

/** The workflow step open in the main view, read-only. */
interface OpenStep {
  runId: string
  stepKey: string
  title: string
  tool: string
}

interface StepViewer {
  step: OpenStep | null
  open: (step: RunMember) => void
  close: () => void
}

const NONE: StepViewer = { step: null, open: () => {}, close: () => {} }

const StepViewerContext = createContext<StepViewer>(NONE)

/** Which workflow step the main view shows. A session picked from the list closes it. */
export function StepViewerProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<OpenStep | null>(null)
  const open = useCallback((member: RunMember) => {
    if (member.stepKey === null) return
    setStep({
      runId: member.runId,
      stepKey: member.stepKey,
      title: member.title,
      tool: member.tool ?? 'agent-hub',
    })
  }, [])
  const close = useCallback(() => setStep(null), [])
  const value = useMemo(() => ({ step, open, close }), [step, open, close])
  return (
    <StepViewerContext.Provider value={value}>
      {children}
    </StepViewerContext.Provider>
  )
}

export const useStepViewer = () => useContext(StepViewerContext)

/** A step's latest attempt, read-only, under a bar that says so and goes back. */
export function StepView({
  step,
  onBack,
}: {
  step: OpenStep
  onBack: () => void
}) {
  return (
    <div
      className="h-full w-full"
      data-testid="step-view"
      style={{ backgroundColor: 'var(--rim)' }}
    >
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex h-12 flex-shrink-0 items-center gap-1.5 pr-3 pl-1.5">
          <button
            type="button"
            className="lantern-icon-btn compact"
            onClick={onBack}
            aria-label="Back to the session"
            title="Back to the session"
          >
            <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
          </button>
          <AgentIcon
            slug={step.tool}
            size={16}
            color={getAgentColor(step.tool, undefined)}
          />
          <h2
            className="min-w-0 flex-1 truncate"
            style={{ font: '450 15px/1.2 var(--font-display)' }}
            title={step.title}
          >
            {step.title}
          </h2>
          <span
            style={{ color: 'var(--mist)', font: '400 12px/1 var(--font-ui)' }}
          >
            Read only
          </span>
        </div>
        <p
          className="mx-3 mb-1.5 flex-shrink-0"
          style={{ color: 'var(--mist)', font: '400 12px/1.4 var(--font-ui)' }}
        >
          The conversation is recorded when the step ends, so a running step can
          look empty until then.
        </p>
        <div
          className="relative mx-1 mb-1 min-h-0 min-w-0 flex-1 overflow-hidden rounded"
          style={{
            backgroundColor: 'var(--ink)',
            boxShadow: 'inset 0 0 0 1px var(--frame-edge)',
          }}
        >
          <AgentHubChat
            key={`${step.runId}:${step.stepKey}`}
            source={{ run: step.runId, step: step.stepKey }}
          />
        </div>
      </div>
    </div>
  )
}
