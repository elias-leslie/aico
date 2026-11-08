/** A project as the engine names it (display names, workspace roots). Tether's project list serves these. */
export interface Project {
  id: string
  name: string
  root: string
  lifecycle: string | null
}
