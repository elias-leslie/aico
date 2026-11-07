'use client'

import { useState } from 'react'
import { PlainMarkdown } from '@/components/PlainMarkdown'
import { isPermanentRefusal } from '@/lib/api-fetch'
import { usePlan } from '@/lib/hooks/use-projects'
import { type PlanBlock, planBlocks } from '@/lib/projects'
import { Popover } from './Popover'
import styles from './ProjectsPage.module.css'

function PlanText({ blocks }: { blocks: PlanBlock[] }) {
  return (
    <div className={styles.planText}>
      {blocks.map((block, index) =>
        block.kind === 'code' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
          <pre key={index}>{block.text}</pre>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
          <PlainMarkdown key={index} text={block.text} />
        ),
      )}
    </div>
  )
}

/** A roadmap item's plan, read in place: loading, failed, empty, not text and cut-short each say so. */
export function PlanSheet({
  projectId,
  path,
  onClose,
}: {
  projectId: string
  path: string
  onClose: () => void
}) {
  const plan = usePlan(projectId, path)
  const [copied, setCopied] = useState(false)
  const doc = plan.data
  const text = doc?.content ?? null

  return (
    <Popover label={doc?.name ?? 'Plan'} onClose={onClose} sheet>
      <div className={styles.planPath}>
        <code title={path}>{path}</code>
        <button
          type="button"
          className="lantern-btn ghost small"
          onClick={() => {
            void navigator.clipboard?.writeText(path).then(
              () => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              },
              () => undefined,
            )
          }}
        >
          {copied ? 'Copied' : 'Copy path'}
        </button>
      </div>
      {plan.isPending && (
        <div className={styles.more} role="status">
          <span className={styles.spin} aria-hidden="true" />
          Opening the plan
        </div>
      )}
      {plan.isError && (
        <div className={styles.problem} role="alert">
          {isPermanentRefusal(plan.error)
            ? `Can’t open this plan: ${plan.error.message}`
            : 'Couldn’t open this plan'}
          {!isPermanentRefusal(plan.error) && (
            <button
              type="button"
              className="lantern-btn small"
              onClick={() => void plan.refetch()}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {doc?.binary && (
        <p className={styles.empty}>
          This file isn’t text, so it can’t be shown here.
        </p>
      )}
      {doc && !doc.binary && text !== null && text.trim() === '' && (
        <p className={styles.empty}>This plan file is empty.</p>
      )}
      {text?.trim() && <PlanText blocks={planBlocks(text)} />}
      {doc?.truncated && (
        <p className={styles.hint}>
          Showing the start; the plan is longer than this.
        </p>
      )}
    </Popover>
  )
}
