/** Forge LLMs adapter. Returns raw model text; validation happens in narrative.ts. */
import { chat, list } from '@forge/llm';
import { err, errorMessage, ok, type Result } from '@ripple/contracts';
import type { NarrativeModel, NarrativeModelError } from '../ports.ts';

async function pickModel(configured: string | undefined): Promise<string | null> {
  if (configured !== undefined && configured !== '') return configured;
  const { models } = await list();
  return models.find((model) => model.status === 'active')?.model ?? null;
}

export function narrativeModel(configuredModel: string | undefined): NarrativeModel {
  return {
    async complete(system: string, user: string): Promise<Result<string, NarrativeModelError>> {
      try {
        const model = await pickModel(configuredModel);
        if (model === null) return err('LLM_ERROR');
        const response = await chat({
          model,
          temperature: 0,
          max_completion_tokens: 2000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        });
        const content = response.choices[0]?.message.content;
        const text = typeof content === 'string' ? content : (content ?? []).map((part) => part.text).join('');
        return text === '' ? err('LLM_ERROR') : ok(text);
      } catch (cause) {
        const message = errorMessage(cause);
        console.warn(`forge llm call failed: ${message}`);
        if (/timeout|timed out/i.test(message)) return err('LLM_TIMEOUT');
        if (/moderat|acceptable use|blocked/i.test(message)) return err('MODERATION_BLOCKED');
        return err('LLM_ERROR');
      }
    },
  };
}
