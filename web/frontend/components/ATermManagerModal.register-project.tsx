'use client'

interface RegisterProjectCardProps {
  projectRegistrySource: 'local' | 'companion'
  registerProjectName: string
  registerProjectRootPath: string
  registerProjectError: string | null
  isRegisteringProject: boolean
  onRegisterProjectNameChange: (value: string) => void
  onRegisterProjectRootPathChange: (value: string) => void
  onRegisterProject: () => void
}

export function RegisterProjectCard({
  projectRegistrySource,
  registerProjectName,
  registerProjectRootPath,
  registerProjectError,
  isRegisteringProject,
  onRegisterProjectNameChange,
  onRegisterProjectRootPathChange,
  onRegisterProject,
}: RegisterProjectCardProps) {
  return (
    <div
      className="rounded-lg px-3.5 py-3"
      style={{
        backgroundColor: 'var(--term-bg-surface)',
        border: '1px solid var(--term-border)',
      }}
    >
      <div className="mb-3">
        <p
          className="text-sm font-medium"
          style={{
            color: 'var(--term-text-primary)',
            fontFamily: 'var(--font-ui)',
          }}
        >
          Register Local Project
        </p>
        <p
          className="mt-1 text-[11px]"
          style={{
            color: 'var(--term-text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {projectRegistrySource === 'local'
            ? 'Add a repo path once, then A-Term can reopen it as a named project workspace.'
            : 'Project registration is managed by the external companion API.'}
        </p>
      </div>
      <div className="grid gap-2 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto]">
        <input
          type="text"
          value={registerProjectName}
          onChange={(event) => onRegisterProjectNameChange(event.target.value)}
          placeholder="Name (optional)"
          className="term-input rounded-md px-3 py-2 text-sm outline-none"
          style={{
            backgroundColor: 'var(--term-bg-deep)',
            border: '1px solid var(--term-border)',
            color: 'var(--term-text-primary)',
            fontFamily: 'var(--font-ui)',
          }}
        />
        <input
          type="text"
          value={registerProjectRootPath}
          onChange={(event) =>
            onRegisterProjectRootPathChange(event.target.value)
          }
          placeholder="/absolute/path/to/project"
          className="term-input rounded-md px-3 py-2 text-sm outline-none"
          style={{
            backgroundColor: 'var(--term-bg-deep)',
            border: '1px solid var(--term-border)',
            color: 'var(--term-text-primary)',
            fontFamily: 'var(--font-mono)',
          }}
        />
        <button
          type="button"
          onClick={onRegisterProject}
          disabled={isRegisteringProject}
          className="rounded-md border px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.12em] transition-all duration-150"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--term-accent) 8%, transparent)',
            borderColor:
              'color-mix(in srgb, var(--term-accent) 30%, transparent)',
            color: 'var(--term-accent)',
            fontFamily: 'var(--font-ui)',
            opacity: isRegisteringProject ? 0.6 : 1,
          }}
        >
          {isRegisteringProject ? 'Adding...' : 'Add'}
        </button>
      </div>
      {registerProjectError && (
        <p
          className="mt-2 text-xs"
          style={{ color: 'var(--term-accent-danger, #f97316)' }}
        >
          {registerProjectError}
        </p>
      )}
    </div>
  )
}
