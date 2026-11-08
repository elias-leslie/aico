// Small shared types of the lifecycle files. Leaves, so the catalog and the root
// code name them without importing each other.

/** The explicit launch options a root's create asked for. */
export interface RootLaunchOptions {
  model: string | null
  reasoningEffort: string | null
  daybreak?: boolean | null
}
