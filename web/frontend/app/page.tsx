import { ATermTabs } from '@/components/ATermTabs'

interface HomePageProps {
  searchParams?: Promise<{
    project?: string | string[]
    dir?: string | string[]
  }>
}

function getSingleSearchParam(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (Array.isArray(value)) {
    return value.find((entry) => entry.length > 0)
  }
  return undefined
}

export default async function Home({ searchParams }: HomePageProps) {
  const resolvedSearchParams = (await searchParams) ?? {}
  const projectId = getSingleSearchParam(resolvedSearchParams.project)
  const projectPath = getSingleSearchParam(resolvedSearchParams.dir)

  return (
    <div
      className="h-dvh flex flex-col"
      style={{ backgroundColor: 'var(--term-bg-deep)' }}
    >
      <ATermTabs
        projectId={projectId}
        projectPath={projectPath}
        className="flex-1 min-h-0"
      />
    </div>
  )
}
