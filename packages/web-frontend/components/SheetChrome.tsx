'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

/** The grab bar at the top of a phone's bottom sheet. */
export function SheetHandle() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto mt-2 h-1 w-9 rounded-full"
      style={{ backgroundColor: 'var(--paper-veil)' }}
    />
  )
}

/** A dialog's title row with its Close button; render inside Dialog.Content. */
export function SheetTitleBar({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 pt-3.5 pr-2 pb-2 pl-[18px]">
      <Dialog.Title
        className="flex-1"
        style={{ font: '500 18px/1.2 var(--font-display)' }}
      >
        {title}
      </Dialog.Title>
      <Dialog.Close aria-label="Close" className="lantern-icon-btn">
        <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
      </Dialog.Close>
    </div>
  )
}
