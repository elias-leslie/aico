// The models Aico knows (data/models.json): only those the launch policy names.

import data from '../data/models.json' with { type: 'json' }

export interface Model {
  id: string
  name: string
  /** Whose subscription or CLI serves it: claude, codex, opencode-go. */
  provider: string
  family: string
  aliases: string[]
  context_window?: number
  max_output_tokens?: number
}

export const MODELS: readonly Model[] = data.models

export class Catalog {
  private readonly byId = new Map<string, Model>()
  private readonly aliases = new Map<string, string>()

  constructor(models: readonly Model[] = MODELS) {
    for (const model of models) {
      this.byId.set(model.id, model)
      for (const alias of model.aliases) this.aliases.set(alias.toLowerCase(), model.id)
    }
  }

  /** The canonical id of an alias; any other name passes through. */
  resolve(name: string): string {
    return this.aliases.get(name.toLowerCase()) ?? name
  }

  /** The entry for an id or alias, if Aico knows the model. */
  get(name: string): Model | undefined {
    return this.byId.get(this.resolve(name))
  }

  all(): readonly Model[] {
    return [...this.byId.values()]
  }
}
