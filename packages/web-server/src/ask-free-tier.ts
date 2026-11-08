// A role marked free_tier in data/service-apps.json gets the Gemini free tier when its own model
// can't answer: Antigravity signed out, out of quota or gone, or a prompt too big for it. One pass
// down the list; a limit or an outage comes back as one failure the app can see, and never retries.

import { type AskOutcome, type AskResult, compileSchema, jsonIn } from '@aico/agent'
import { maskSecrets } from '@aico/shared/secrets'
import { generate, silenceBound } from '@aico/video'

export const FREE_TIER_PROVIDER = 'gemini-free-tier'

export interface FreeTierPolicy {
  models: string[]
  wire_silence_seconds: number
}

export type AskFallback = (
  policy: FreeTierPolicy,
  question: string,
  schema: unknown,
  first: AskResult,
  env: NodeJS.ProcessEnv,
  send?: typeof generate,
) => Promise<AskResult & { provider?: string }>

/** A dead or absent model, or a prompt it can't take. A refusal, a swap or a bad answer stays what it is. */
export function wantsFreeTier(outcome: AskOutcome): boolean {
  return (
    outcome.kind === 'error' ||
    outcome.kind === 'silent' ||
    (outcome.kind === 'bad_input' && outcome.too_big === true)
  )
}

const why = (outcome: AskOutcome) =>
  'detail' in outcome ? outcome.detail : `${outcome.kind} from the model`

export const askFreeTier: AskFallback = async (
  policy,
  question,
  schema,
  first,
  env,
  send = generate,
) => {
  const started = Date.now()
  const compiled = schema === undefined ? undefined : compileSchema(schema)
  const text =
    schema === undefined
      ? question
      : `${question}\n\nReply with only one JSON value that fits this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`
  const failures: string[] = []
  for (const model of policy.models) {
    try {
      const answer = await send(model, [{ text }], {
        env,
        post: silenceBound(policy.wire_silence_seconds),
        once: true,
      })
      const tokens = { input: answer.usage.prompt, output: answer.usage.output }
      const finish = (outcome: AskOutcome): AskResult & { provider: string } => ({
        outcome,
        tokens,
        wallMs: first.wallMs + Date.now() - started,
        provider: FREE_TIER_PROVIDER,
      })
      if (schema === undefined) return finish({ kind: 'done', model, text: answer.text })
      const found = jsonIn(answer.text)
      const errors =
        found && compiled && 'validate' in compiled
          ? compiled.validate(found.value)
          : ['the answer is not JSON']
      if (found && !errors.length)
        return finish({
          kind: 'done',
          model,
          text: JSON.stringify(found.value),
          data: found.value,
        })
      failures.push(`${model}: ${errors.join(', ')}`)
    } catch (error) {
      failures.push(`${model}: ${(error as Error).message}`)
    }
  }
  const model = 'model' in first.outcome ? first.outcome.model : (policy.models[0] as string)
  return {
    outcome: {
      kind: 'error',
      model,
      detail: maskSecrets(
        `${why(first.outcome)}; the free tier didn't answer either: ${failures.join('; ')}`,
      ),
    },
    tokens: first.tokens,
    wallMs: first.wallMs + Date.now() - started,
  }
}
