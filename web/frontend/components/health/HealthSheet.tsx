'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { clsx } from 'clsx'
import { ExternalLink, X } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  ageText,
  callsText,
  type HealthFinding,
  type HealthTile,
  handledBy,
  leftText,
  type NightshiftOwnerView,
  STATE_TONE,
  STATE_WORD,
  TONE_COLOR,
  type Tone,
  unknownReason,
  whenText,
} from '@/lib/health'
import { useHealth } from '@/lib/hooks/use-health'
import { useMediaQuery } from '@/lib/hooks/use-media-query'

/** Nightshift's status, read-only: answers and approvals stay in Nightshift. */
export function HealthSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const { result, isLoading, isError, refetch } = useHealth()
  const view = result?.available ? result.view : null
  const unknown = unknownReason(result, isError)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000]"
          style={{ backgroundColor: 'var(--scrim)' }}
        />
        <Dialog.Content
          data-testid="health-sheet"
          aria-describedby={undefined}
          className={clsx(
            'lantern-sheet fixed z-[10001] flex flex-col overflow-hidden outline-none',
            isMobile
              ? 'lantern-rise inset-x-0 bottom-0 h-[84dvh] rounded-t-[14px]'
              : 'lantern-enter top-1/2 left-1/2 max-h-[min(90dvh,760px)] w-[min(94vw,760px)] -translate-x-1/2 -translate-y-1/2 rounded-xl',
          )}
          style={{ color: 'var(--bone)' }}
        >
          {isMobile && (
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-9 rounded-full"
              style={{ backgroundColor: 'var(--paper-veil)' }}
            />
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-3.5 pr-2 pb-2 pl-[18px]">
            <Dialog.Title style={{ font: '500 18px/1.2 var(--font-display)' }}>
              Health
            </Dialog.Title>
            <span
              className="min-w-0 flex-1 text-[12px]"
              style={{ color: 'var(--mist)' }}
            >
              {view?.snapshot.state === 'fresh'
                ? `From Nightshift · updated ${ageText(view.snapshot.age)} ago`
                : 'From Nightshift'}
            </span>
            {view?.links.status && (
              <OutLink href={view.links.status}>Open Nightshift</OutLink>
            )}
            <Dialog.Close aria-label="Close" className="lantern-icon-btn">
              <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[18px] pb-[18px]">
            {isLoading ? (
              <Note>Loading health from Nightshift…</Note>
            ) : (
              <>
                {unknown && (
                  <Note testId="health-unknown">
                    {unknown}{' '}
                    <button
                      type="button"
                      className="inline-flex min-h-11 items-center underline underline-offset-2 md:min-h-0"
                      style={{ color: 'var(--lantern)' }}
                      onClick={() => void refetch()}
                    >
                      Try again
                    </button>
                  </Note>
                )}
                <HealthBody view={view} />
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const UNKNOWN_TILES: HealthTile[] = [
  ['disk', 'System disk'],
  ['backups', 'Backups'],
  ['services', 'Services'],
  ['pve', 'Proxmox host'],
].map(([id, label]) => ({
  id,
  label,
  state: 'unkn',
  summary: 'No current data',
  age: null,
  link: '',
}))

function HealthBody({ view }: { view: NightshiftOwnerView | null }) {
  const tiles = view?.tiles.length ? view.tiles : UNKNOWN_TILES
  const findings = view?.findings ?? []
  return (
    <div className="flex flex-col gap-4">
      <ul
        aria-label="Health at a glance"
        className="grid grid-cols-2 gap-2 md:grid-cols-4"
      >
        {tiles.map((tile) => (
          <Tile key={tile.id} tile={tile} />
        ))}
      </ul>
      {view && (view.needs_you > 0 || view.approvals.length > 0) && (
        <section aria-label="Waiting on you" className="flex flex-col gap-2">
          {view.needs_you > 0 && (
            <Row>
              <span className="flex-1">{callsText(view)}</span>
              <OutLink href={view.links.needs_you}>
                Answer in Nightshift
              </OutLink>
            </Row>
          )}
          {view.approvals.map((approval) => (
            <Row key={approval.id} testId="health-approval">
              <span className="min-w-0 flex-1 break-words">
                {approval.title}
                <small
                  className="block text-[12px]"
                  style={{ color: 'var(--mist)' }}
                >
                  Approval waiting · {leftText(approval.left)}
                </small>
              </span>
              <OutLink href={approval.url}>
                Approve in Nightshift (security key)
              </OutLink>
            </Row>
          ))}
        </section>
      )}
      {view && (
        <section aria-labelledby="health-findings-h">
          <h3
            id="health-findings-h"
            className="mb-1.5 text-[12px] tracking-[0.05em] uppercase"
            style={{ color: 'var(--mist)' }}
          >
            Problems
          </h3>
          {findings.length === 0 ? (
            <Note>
              {view.snapshot.state === 'fresh'
                ? 'No problems on any host.'
                : 'No problems in the last check Nightshift reported.'}
            </Note>
          ) : (
            <ul className="flex flex-col" aria-label="Problems">
              {findings.map((finding) => (
                <Finding key={finding.id} finding={finding} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function Tile({ tile }: { tile: HealthTile }) {
  const tone = STATE_TONE[tile.state]
  const word = STATE_WORD[tile.state]
  // Only a problem (warning, critical) has been open; other ages are results'.
  const open = tile.state === 'warn' || tile.state === 'crit' ? tile.age : null
  const when = whenText(tile.checked, open)
  return (
    <li
      data-testid={`health-tile-${tile.id}`}
      data-state={tile.state}
      className="min-w-0 rounded-lg px-2.5 py-2"
      style={{
        border: '1px solid var(--paper-veil)',
        backgroundColor: 'var(--paper)',
      }}
      title={tile.summary}
    >
      <div
        className="flex items-center gap-1.5 text-[11px]"
        style={{ color: 'var(--mist)' }}
      >
        <span className="min-w-0 flex-1 truncate">{tile.label}</span>
        <Chip tone={tone}>{word}</Chip>
      </div>
      <p className="mt-1 text-[13px] leading-[1.35] break-words">
        {tile.summary}
      </p>
      {when && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--mist)' }}>
          {when}
        </p>
      )}
    </li>
  )
}

function Finding({ finding }: { finding: HealthFinding }) {
  return (
    <li
      data-testid="health-finding"
      className="flex flex-col gap-1 py-2.5"
      style={{ borderTop: '1px solid var(--paper-veil)' }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={STATE_TONE[finding.state]}>
          {STATE_WORD[finding.state]}
        </Chip>
        <span className="text-[12px]" style={{ color: 'var(--mist)' }}>
          {[
            finding.host_label,
            finding.check,
            whenText(finding.checked, finding.age),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <p className="text-[13px] leading-[1.4] break-words">{finding.summary}</p>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p
          className="min-w-0 flex-1 text-[12px] break-words"
          style={{ color: 'var(--mist)' }}
        >
          {handledBy(finding)}
          {finding.next ? ` ${finding.next}` : ''}
        </p>
        {finding.link && (
          <OutLink href={finding.link}>
            {finding.owner ? 'Answer in Nightshift' : 'Details'}
          </OutLink>
        )}
      </div>
    </li>
  )
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const color = TONE_COLOR[tone]
  return (
    <span
      data-tone={tone}
      className="inline-flex flex-none items-center gap-1 rounded-md px-1.5 py-px text-[11px] leading-4"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {children}
    </span>
  )
}

function Row({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-[13px]"
      style={{
        border: '1px solid rgb(var(--lantern-rgb) / 0.35)',
        backgroundColor: 'rgb(var(--lantern-rgb) / 0.08)',
      }}
    >
      {children}
    </div>
  )
}

function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="inline-flex min-h-11 flex-none items-center gap-1 text-[12px] underline-offset-2 hover:underline md:min-h-0"
      style={{ color: 'var(--lantern)' }}
    >
      {children}
      <ExternalLink className="h-3 w-3" strokeWidth={1.8} aria-hidden="true" />
    </a>
  )
}

function Note({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p
      data-testid={testId}
      className="mb-3 text-[13px]"
      style={{ color: 'var(--mist)' }}
    >
      {children}
    </p>
  )
}
