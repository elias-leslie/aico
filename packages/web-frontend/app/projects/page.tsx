'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { ProjectsPage } from '@/components/projects/ProjectsPage'

/** /projects, and one project at /projects?id=<id>. */
function Projects() {
  const router = useRouter()
  const selected = useSearchParams().get('id') ?? ''
  return (
    <ProjectsPage
      selected={selected}
      onSelect={(id) =>
        router.push(id ? `/projects?id=${encodeURIComponent(id)}` : '/projects')
      }
    />
  )
}

export default function ProjectsRoute() {
  return (
    <Suspense fallback={null}>
      <Projects />
    </Suspense>
  )
}
