'use client'

import { useState } from 'react'
import { ConfirmationDialog } from '@/components/ConfirmationDialog'
import { usePower } from '@/lib/hooks/use-projects'
import {
  type Place,
  type PowerAction,
  placeName,
  powerLabel,
  powerSummary,
} from '@/lib/projects'

const PENDING: Record<PowerAction, string> = {
  start: 'Starting…',
  shutdown: 'Shutting down…',
  restart: 'Restarting…',
}

/** The confirm sheet for a place's power button; it names the target in every button. */
export function PowerSheet({
  projectId,
  index,
  place,
  actions,
  agents,
  now,
  onClose,
}: {
  projectId: string
  index: number
  place: Place
  actions: PowerAction[]
  agents: number
  now: number
  onClose: () => void
}) {
  const power = usePower(projectId, index)
  const [asked, setAsked] = useState<PowerAction>(actions[0])
  const target = placeName(place)
  const [main, other] = actions

  const run = (action: PowerAction) => {
    setAsked(action)
    power.mutate(action, { onSuccess: onClose })
  }

  return (
    <ConfirmationDialog
      isOpen
      title={target}
      message={powerSummary(place, agents, now)}
      confirmText={powerLabel(main, target)}
      secondaryText={other ? powerLabel(other, target) : undefined}
      onSecondary={other ? () => run(other) : undefined}
      variant={main === 'start' ? 'warning' : 'danger'}
      isPending={power.isPending}
      pendingText={PENDING[asked]}
      error={power.error ? power.error.message : null}
      onConfirm={() => run(main)}
      onCancel={onClose}
    />
  )
}
