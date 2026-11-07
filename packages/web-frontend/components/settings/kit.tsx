'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { type FormHTMLAttributes, type ReactNode, useId, useState } from 'react'
import styles from './kit.module.css'

/** The state words every Settings row uses, as the side panel's chips: ok, late, failed, off, running. */
export type Chip = 'ok' | 'late' | 'failed' | 'off' | 'running' | 'warn'

/** A section's top line: its name, one quiet sentence, and its actions on the right. */
export function SectionHead({
  title,
  sub,
  children,
}: {
  title: string
  sub?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={styles.sectionHead}>
      <div className={styles.sectionTitle}>
        <h2>{title}</h2>
        {sub && <p role="status">{sub}</p>}
      </div>
      {children && <div className={styles.sectionActions}>{children}</div>}
    </div>
  )
}

/** A titled list: a quiet small label with its count, then the rows. */
export function Group({
  title,
  count,
  label,
  children,
}: {
  title: string
  count?: number
  /** The list's accessible name when it differs from the title. */
  label?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className={styles.group} aria-labelledby={id}>
      <h3 id={id} className="lantern-sec">
        {title}
        {count !== undefined && <span className="n">{count}</span>}
      </h3>
      <ul className={styles.rows} aria-label={label}>
        {children}
      </ul>
    </section>
  )
}

/** One row: a name, a short meta line and a state chip. Activating it opens its detail and actions in place. */
export function Row({
  name,
  meta,
  chip,
  chipText,
  chipTitle,
  children,
  defaultOpen = false,
  id,
  label,
}: {
  name: string
  meta?: ReactNode
  chip?: Chip
  chipText?: string
  /** A tooltip that says more about the state. */
  chipTitle?: string
  /** The detail and actions shown when the row is open; without it the row is plain. */
  children?: ReactNode
  defaultOpen?: boolean
  id?: string
  /** The button's accessible name, when the visible text alone would be unclear. */
  label?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const panel = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  const head = (
    <>
      {children ? (
        <Chevron
          className={styles.chevron}
          strokeWidth={1.7}
          aria-hidden="true"
        />
      ) : (
        <span className={styles.chevron} aria-hidden="true" />
      )}
      <span className={styles.main}>
        <span className={styles.name}>{name}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
      </span>
      {chip && chipText && (
        <span
          className={`status-chip ${chip} ${styles.chip}`}
          title={chipTitle}
        >
          {chipText}
        </span>
      )}
    </>
  )
  return (
    <li className={styles.row} id={id} data-open={open ? 'true' : undefined}>
      {children ? (
        <button
          type="button"
          className={styles.rowHead}
          aria-expanded={open}
          aria-controls={panel}
          aria-label={label}
          onClick={() => setOpen((now) => !now)}
        >
          {head}
        </button>
      ) : (
        <div className={styles.rowHead} data-plain="">
          {head}
        </div>
      )}
      {children && open && (
        <div id={panel} className={styles.detail}>
          {children}
        </div>
      )}
    </li>
  )
}

/** A row of an open row's actions: quiet buttons, the destructive one set apart. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>
}

/** A compact form: labelled fields in two columns (one on a phone). */
export function Form({
  children,
  ...props
}: FormHTMLAttributes<HTMLFormElement>) {
  return (
    <form className={styles.form} {...props}>
      {children}
    </form>
  )
}

/** A notice in a section: a status line, or an alert when it failed. */
export function Notice({
  children,
  failed = false,
  actions,
}: {
  children: ReactNode
  failed?: boolean
  actions?: ReactNode
}) {
  return (
    <div
      className={styles.notice}
      data-failed={failed ? 'true' : undefined}
      role={failed ? 'alert' : 'status'}
    >
      <p>{children}</p>
      {actions}
    </div>
  )
}

/** A quiet line: loading, empty, or a hint. */
export function Quiet({
  children,
  role,
}: {
  children: ReactNode
  role?: 'status' | 'alert'
}) {
  return (
    <p className={styles.quiet} role={role}>
      {children}
    </p>
  )
}

/** The find box a long list gets. */
export function Find({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder: string
}) {
  return (
    <label className={styles.find}>
      <span className={styles.srOnly}>{label}</span>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}
