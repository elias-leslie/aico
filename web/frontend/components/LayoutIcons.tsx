/**
 * Custom SVG layout icons that accurately represent each pane arrangement.
 * Each icon is a miniature diagram of the actual layout.
 */

interface LayoutIconProps {
  className?: string
  style?: React.CSSProperties
}

/** Two vertical columns side by side: || */
export function ColumnsSideBySideIcon({ className, style }: LayoutIconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} style={style}>
      <rect x="1" y="2" width="6" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="2" width="6" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** Two horizontal rows stacked: = */
export function RowsStackedIcon({ className, style }: LayoutIconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} style={style}>
      <rect x="1" y="1.5" width="14" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1" y="9" width="14" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** One wide pane on top, two smaller panes on bottom */
export function MainSideIcon({ className, style }: LayoutIconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} style={style}>
      <rect x="1" y="1.5" width="14" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1" y="9.5" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9.5" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** 2x2 grid */
export function GridIcon({ className, style }: LayoutIconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} style={style}>
      <rect x="1" y="1.5" width="6" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="1.5" width="6" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1" y="9" width="6" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9" width="6" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** Wide grid — 3x2 or 2x3 */
export function WideGridIcon({ className, style }: LayoutIconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} style={style}>
      <rect x="0.5" y="1.5" width="4.3" height="5.5" rx="0.75" stroke="currentColor" strokeWidth="1.2" />
      <rect x="5.85" y="1.5" width="4.3" height="5.5" rx="0.75" stroke="currentColor" strokeWidth="1.2" />
      <rect x="11.2" y="1.5" width="4.3" height="5.5" rx="0.75" stroke="currentColor" strokeWidth="1.2" />
      <rect x="0.5" y="9" width="4.3" height="5.5" rx="0.75" stroke="currentColor" strokeWidth="1.2" />
      <rect x="5.85" y="9" width="4.3" height="5.5" rx="0.75" stroke="currentColor" strokeWidth="1.2" />
      <rect x="11.2" y="9" width="4.3" height="5.5" rx="0.75" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}
