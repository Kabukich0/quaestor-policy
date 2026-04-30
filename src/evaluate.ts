/**
 * The single entry point used by quaestor-core: evaluateRedemption.
 *
 * Privacy invariants enforced here:
 *   - Intent is read once into the prompt and never returned to the caller
 *     except as part of the model's reasoning string (which the user already
 *     authored; surfacing the model's gloss back to them is fine).
 *   - We never log the intent. The only stderr writes are model-load progress.
 *   - The model handle stays in this module's closure; consumers cannot
 *     inspect KV cache or reach into the underlying llama.cpp session.
 *
 * Performance:
 *   - First call lazy-loads the model (~5–30s on cold disk).
 *   - Subsequent calls reuse the same LlamaModel + LlamaContext.
 *   - Each evaluation creates a fresh chat session (no cross-call leakage).
 */
import { z } from 'zod';
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
  type MandateSummary,
  type PromptInput,
  type RedemptionContext,
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  buildRetryPrompt,
  buildUserPrompt,
} from './prompt.js';

export const EvaluateInputSchema = z.object({
  intent: z.string(),
  mandate_summary: z.object({
    spend_cap_remaining: z.string(),
    recipient_policy: z.string(),
    expiry_iso: z.string(),
    use_counter_remaining: z.number().int().nonnegative(),
  }),
  redemption: z.object({
    recipient_address: z.string(),
    recipient_domain: z.string().optional(),
    amount_usdc: z.string(),
    resource_description: z.string().optional(),
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

/**
 * What the daemon dynamically imports. Held as a module singleton so the
 * 2GB model is loaded exactly once per daemon process.
 */
interface ModelHandle {
  spec: ModelSpec;
  // node-llama-cpp types — kept opaque here so the rest of the file isn't
  // coupled to its public types (which moved twice in the 3.x line).
  // biome-ignore lint/suspicious/noExplicitAny: external typed loosely on purpose
  llama: any;
  // biome-ignore lint/suspicious/noExplicitAny: external typed loosely on purpose
  model: any;
  // biome-ignore lint/suspicious/noExplicitAny: external typed loosely on purpose
  grammar: any;
}

let cached: Promise<ModelHandle> | null = null;

async function loadHandle(spec: ModelSpec = QWEN_2_5_3B_Q4KM): Promise<ModelHandle> {
  if (!(await modelExists(spec))) throw new ModelMissingError(spec);
  // biome-ignore lint/suspicious/noExplicitAny: node-llama-cpp dynamic import
  const llamaMod: any = await import('node-llama-cpp');
  const llama = await llamaMod.getLlama();
  const model = await llama.loadModel({ modelPath: modelPath(spec) });
  const grammar = await llama.createGrammarForJsonSchema(RESPONSE_SCHEMA);
  return { spec, llama, model, grammar };
}

/**
 * Pre-warm the model. Useful for daemons that want to amortise the load cost
 * before the first request arrives. Idempotent.
 */
export async function preload(spec: ModelSpec = QWEN_2_5_3B_Q4KM): Promise<void> {
  if (!cached) cached = loadHandle(spec);
  await cached;
}

/**
 * Evaluate a redemption against the mandate's intent. Returns a structured
 * verdict + enforcement decision. Never throws on a bad model output — falls
 * back to soft_warn so a flaky model can't deny legitimate payments.
 *
 * Throws:
 *   - ModelMissingError if the GGUF isn't installed.
 *   - Other errors only for genuine system failures (OOM, disk gone, etc.).
 */
export async function evaluateRedemption(input: EvaluateInput): Promise<EvaluateResult> {
  const parsed = EvaluateInputSchema.parse(input);
  const start = Date.now();

  // Empty-intent fast path — the daemon also short-circuits this, but be
  // defensive. The model would correctly approve at confidence 1.0; we just
  // skip the inference entirely.
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

  const userPrompt = buildUserPrompt(parsed as PromptInput);
  const first = await runOnce(handle, userPrompt);
  let parsedOut = parseModelOutput(first);

  if (!parsedOut.ok) {
    const retry = await runOnce(handle, buildRetryPrompt(parsed as PromptInput, first));
    parsedOut = parseModelOutput(retry);
  }

  if (!parsedOut.ok || !parsedOut.verdict) {
    // Fail-safe: soft warn, NOT hard reject. A confused model must not block
    // a payment whose structured policy has already cleared.
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
  // 2048 fits the system prompt (~1100 tokens) + per-request body (~400 tokens) +
  // headroom for the 256-token output. Halving from 4096 nets ~30% latency on M-series.
  const ctx = await handle.model.createContext({ contextSize: 2048 });
  try {
    // biome-ignore lint/suspicious/noExplicitAny: node-llama-cpp dynamic import
    const llamaMod: any = await import('node-llama-cpp');
    const session = new llamaMod.LlamaChatSession({
      contextSequence: ctx.getSequence(),
      systemPrompt: SYSTEM_PROMPT,
    });
    const out = await session.prompt(userPrompt, {
      grammar: handle.grammar,
      maxTokens: 200,
      temperature: 0.1,
      topP: 0.9,
    });
    return String(out);
  } finally {
    await ctx.dispose();
  }
}

/** Reset the cached model — used by tests + when reloading config. */
export function resetForTesting(): void {
  cached = null;
}

export type { Enforcement, MandateSummary, RedemptionContext };
export { HARD_REJECT_THRESHOLD };
