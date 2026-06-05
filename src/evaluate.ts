/**
 * The single entry point used by quaestor-core: evaluateRedemption.
 *
 * Goldseel v0.2.0 changes from v0.1.0:
 *   - Input redemption is enriched with recipient_categories + recipient_name
 *     from @quaestor/vendor-registry. If a caller passes a raw redemption
 *     (no recipient_categories), we enrich on the fly so callers don't have
 *     to change.
 *   - Model emits plain-text VERDICT/REASONING instead of JSON. No grammar.
 *
 * Privacy invariants enforced here:
 *   - Intent is read once into the prompt and never returned to the caller
 *     except as part of the model's reasoning string.
 *   - We never log the intent.
 *   - The model handle stays in this module's closure.
 */
import { z } from 'zod';
import { enrichRedemption as enrich } from '@quaestor/vendor-registry';
import {
  ModelMissingError,
  QWEN_2_5_3B_Q4KM,
  type ModelSpec,
  modelExists,
  modelPath,
} from './model.js';
import {
  type Enforcement,
  HARD_REJECT_THRESHOLD,
  classify,
} from './enforcement.js';
import { parseModelOutput } from './parse.js';
import {
  type EnrichedRedemption,
  type MandateSummary,
  type PromptInput,
  SYSTEM_PROMPT,
  buildRetryPrompt,
  buildUserPrompt,
} from './prompt.js';

/**
 * Caller can pass either a raw redemption or a pre-enriched one. If
 * recipient_categories is missing, we look it up via the vendor registry.
 */
export const EvaluateInputSchema = z.object({
  intent: z.string(),
  mandate_summary: z.object({
    spend_cap_remaining: z.string(),
    recipient_policy: z.string(),
    expiry_iso: z.string(),
    use_counter_remaining: z.number().int().nonnegative().nullable(),
  }),
  redemption: z.object({
    recipient_address: z.string().nullable().optional(),
    recipient_domain: z.string().optional(),
    amount_usdc: z.string(),
    resource_description: z.string().optional(),
    recipient_categories: z.array(z.string()).optional(),
    recipient_name: z.string().nullable().optional(),
    vendor_known: z.boolean().optional(),
  }),
});

export type EvaluateInput = z.infer<typeof EvaluateInputSchema>;

export interface EvaluateResult {
  verdict: 'approve' | 'reject';
  confidence: number;
  reasoning: string;
  enforcement: Enforcement;
  latency_ms: number;
  model_id: string;
}

interface ModelHandle {
  spec: ModelSpec;
  // biome-ignore lint/suspicious/noExplicitAny: external typed loosely on purpose
  llama: any;
  // biome-ignore lint/suspicious/noExplicitAny: external typed loosely on purpose
  model: any;
}

let cached: Promise<ModelHandle> | null = null;

async function loadHandle(spec: ModelSpec = QWEN_2_5_3B_Q4KM): Promise<ModelHandle> {
  // QUAESTOR_MODEL_PATH overrides everything: useful for evaluating a
  // specific Goldseel GGUF without overwriting the production install.
  const override = process.env.QUAESTOR_MODEL_PATH;
  const effectivePath = override ?? modelPath(spec);
  if (!override && !(await modelExists(spec))) throw new ModelMissingError(spec);
  // biome-ignore lint/suspicious/noExplicitAny: node-llama-cpp dynamic import
  const llamaMod: any = await import('node-llama-cpp');
  const llama = await llamaMod.getLlama();
  const model = await llama.loadModel({ modelPath: effectivePath });
  return { spec: override ? { ...spec, id: `override:${override}` } : spec, llama, model };
}

export async function preload(spec: ModelSpec = QWEN_2_5_3B_Q4KM): Promise<void> {
  if (!cached) cached = loadHandle(spec);
  await cached;
}

function ensureEnriched(red: EvaluateInput['redemption']): EnrichedRedemption {
  if (
    red.recipient_categories !== undefined &&
    red.recipient_name !== undefined &&
    red.vendor_known !== undefined
  ) {
    return {
      recipient_address: red.recipient_address ?? null,
      recipient_domain: red.recipient_domain ?? '',
      amount_usdc: red.amount_usdc,
      resource_description: red.resource_description ?? '',
      recipient_categories: red.recipient_categories,
      recipient_name: red.recipient_name,
      vendor_known: red.vendor_known,
    };
  }
  const e = enrich({ recipient_domain: red.recipient_domain ?? '' });
  return {
    recipient_address: red.recipient_address ?? null,
    recipient_domain: red.recipient_domain ?? '',
    amount_usdc: red.amount_usdc,
    resource_description: red.resource_description ?? '',
    recipient_categories: e.recipient_categories,
    recipient_name: e.recipient_name,
    vendor_known: e.recipient_categories.length > 0,
  };
}

export async function evaluateRedemption(input: EvaluateInput): Promise<EvaluateResult> {
  const parsed = EvaluateInputSchema.parse(input);
  const start = Date.now();

  if (parsed.intent.trim().length === 0) {
    return {
      verdict: 'approve',
      confidence: 1.0,
      reasoning: 'no intent supplied; structured policy already passed',
      enforcement: 'approve',
      latency_ms: Date.now() - start,
      model_id: QWEN_2_5_3B_Q4KM.id,
    };
  }

  if (!cached) cached = loadHandle();
  const handle = await cached;

  const enrichedRedemption = ensureEnriched(parsed.redemption);
  const promptInput: PromptInput = {
    intent: parsed.intent,
    mandate_summary: {
      ...parsed.mandate_summary,
      use_counter_remaining: parsed.mandate_summary.use_counter_remaining ?? Number.POSITIVE_INFINITY,
    } as MandateSummary,
    redemption: enrichedRedemption,
  };

  const userPrompt = buildUserPrompt(promptInput);
  const first = await runOnce(handle, userPrompt);
  let parsedOut = parseModelOutput(first);

  if (!parsedOut.ok) {
    const retry = await runOnce(handle, buildRetryPrompt(promptInput, first));
    parsedOut = parseModelOutput(retry);
  }

  if (!parsedOut.ok || !parsedOut.verdict) {
    return {
      verdict: 'reject',
      confidence: 0.5,
      reasoning: 'policy engine failed to evaluate; defaulting to soft warn',
      enforcement: 'soft_warn',
      latency_ms: Date.now() - start,
      model_id: handle.spec.id,
    };
  }

  return {
    verdict: parsedOut.verdict.verdict,
    confidence: parsedOut.verdict.confidence,
    reasoning: parsedOut.verdict.reasoning,
    enforcement: classify(parsedOut.verdict),
    latency_ms: Date.now() - start,
    model_id: handle.spec.id,
  };
}

async function runOnce(handle: ModelHandle, userPrompt: string): Promise<string> {
  const ctx = await handle.model.createContext({ contextSize: 2048 });
  try {
    // biome-ignore lint/suspicious/noExplicitAny: node-llama-cpp dynamic import
    const llamaMod: any = await import('node-llama-cpp');
    const session = new llamaMod.LlamaChatSession({
      contextSequence: ctx.getSequence(),
      systemPrompt: SYSTEM_PROMPT,
    });
    const out = await session.prompt(userPrompt, {
      maxTokens: 200,
      temperature: 0.1,
      topP: 0.9,
    });
    return String(out);
  } finally {
    await ctx.dispose();
  }
}

export function resetForTesting(): void {
  cached = null;
}

export type { Enforcement, EnrichedRedemption, MandateSummary };
export { HARD_REJECT_THRESHOLD };
