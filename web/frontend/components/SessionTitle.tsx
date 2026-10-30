/**
 * A session title, `Project — Task`. When space runs out the project
 * truncates first, so the task (what tells sessions apart) stays readable.
 * It gives up width before the host chip beside it (HostBadge).
 */
export function SessionTitle({
  name,
  task,
}: {
  name: string
  task?: string | null
}) {
  const separator = ' — '
  if (!task || !name.endsWith(`${separator}${task}`)) {
    return (
      <span
        className="truncate"
        style={{ flex: '1 100 auto', minWidth: '4ch' }}
      >
        {name}
      </span>
    )
  }
  const project = name.slice(0, -(task.length + separator.length))
  return (
    <span
      className="flex items-baseline"
      style={{ flex: '1 100 auto', minWidth: '6ch' }}
    >
      <span className="truncate" style={{ flexShrink: 4, minWidth: '2ch' }}>
        {project}
      </span>
      <span className="shrink-0 whitespace-pre">{separator}</span>
      <span className="min-w-0 truncate">{task}</span>
    </span>
  )
}
