// Semantic classifier (Stage 3 of cascade).
//
// Wraps the existing model call but with a SIMPLIFIED system prompt — by
// the time we reach here, all deterministic rule checks (cap, counter,
// expiry, blocklist, phishing, allowlist) have already passed. The model
// only has to decide "does the recipient's category match what the intent
// authorizes?".
//
// Model GGUF: training/quaestor-goldseel-7b-v0.2.1.gguf (or override via
// QUAESTOR_MODEL_PATH env). Output format: VERDICT/REASONING plain text.

import {
  ModelMissingError,
  QWEN_2_5_3B_Q4KM,
  type ModelSpec,
  modelExists,
  modelPath,
} from '../model.js';
import { parseModelOutput } from '../parse.js';
import type { CascadeMandate, EnrichedRedemption } from '../cascade-types.js';

// Byte-identical to training/finetune_modal.py:SYSTEM_PROMPT — the model was
// trained expecting this prompt shape, so Stage 3 must use it verbatim even
// though the hard rules already enforced rules 1 (mandate state) etc. The
// hard rules will have rejected those cases before reaching here, but the
// prompt the model sees stays the same.
export const SEMANTIC_SYSTEM_PROMPT =
  "You are Quaestor's mandate enforcement classifier. You receive " +
  'an INTENT (the user-authorized purpose), a MANDATE_SUMMARY ' +
  '(spend cap, expiry, recipient policy, use counter), and a ' +
  'REDEMPTION (the proposed payment, including pre-classified ' +
  'recipient_categories from a vendor registry).\n\n' +
  'Your job: decide approve or reject based on three rules:\n' +
  '1. MANDATE STATE: if amount > spend_cap_remaining, or ' +
  'use_counter_remaining = 0, or expiry has passed, or ' +
  'recipient is explicitly disallowed by recipient_policy ' +
  '→ reject.\n' +
  '2. CATEGORY MATCH: do recipient_categories match what INTENT ' +
  'authorizes? If yes → approve. If clearly different → reject.\n' +
  '3. EXPLICIT CARVE-OUTS: if INTENT contains explicit allowance ' +
  'for this category → approve. If INTENT contains explicit ' +
  'prohibition → reject.\n\n' +
  'Output VERDICT (approve|reject) followed by REASONING that ' +
  'cites the specific rule that fired. Examples of valid ' +
  'reasoning:\n' +
  "  - 'Cap exceeded: amount $95 > spend_cap_remaining $80'\n" +
  "  - 'Category match: recipient_categories=[ml-inference] " +
  "matches intent authorizing AI inference'\n" +
  "  - 'Counter exhausted: use_counter_remaining = 0'\n\n" +
  'If vendor_known is false, fall back to evaluating ' +
  'recipient_domain and resource_description directly.';

interface ModelHandle {
  spec: ModelSpec;
  // biome-ignore lint/suspicious/noExplicitAny: node-llama-cpp dynamic
  llama: any;
  // biome-ignore lint/suspicious/noExplicitAny: node-llama-cpp dynamic
  model: any;
}

let cached: Promise<ModelHandle> | null = null;

async function loadHandle(spec: ModelSpec = QWEN_2_5_3B_Q4KM): Promise<ModelHandle> {
  const override = process.env.QUAESTOR_MODEL_PATH;
  const effectivePath = override ?? modelPath(spec);
  if (!override && !(await modelExists(spec))) throw new ModelMissingError(spec);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  const llamaMod: any = await import('node-llama-cpp');
  const llama = await llamaMod.getLlama();
  const model = await llama.loadModel({ modelPath: effectivePath });
  return { spec, llama, model };
}

export interface SemanticResult {
  verdict: 'approve' | 'reject';
  reasoning: string;
  confidence: number;
}

function buildUserMsg(
  mandate: CascadeMandate,
  intent: string,
  redemption: EnrichedRedemption,
): string {
  const view = {
    recipient_domain: redemption.recipient_domain,
    recipient_name: redemption.recipient_name,
    recipient_categories: redemption.recipient_categories,
    vendor_known: redemption.vendor_known,
    amount_usdc: redemption.amount_usdc,
    resource_description: redemption.resource_description,
  };
  return (
    `INTENT: ${intent}\n` +
    `MANDATE_SUMMARY: ${JSON.stringify(mandate)}\n` +
    `REDEMPTION: ${JSON.stringify(view)}`
  );
}

export async function runSemanticClassifier(
  mandate: CascadeMandate,
  intent: string,
  redemption: EnrichedRedemption,
): Promise<SemanticResult> {
  if (intent.trim().length === 0) {
    return {
      verdict: 'approve',
      reasoning: 'no intent supplied; structured policy already passed',
      confidence: 1.0,
    };
  }

  if (!cached) cached = loadHandle();
  const handle = await cached;
  const userMsg = buildUserMsg(mandate, intent, redemption);

  const ctx = await handle.model.createContext({ contextSize: 2048 });
  try {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import
    const llamaMod: any = await import('node-llama-cpp');
    const session = new llamaMod.LlamaChatSession({
      contextSequence: ctx.getSequence(),
      systemPrompt: SEMANTIC_SYSTEM_PROMPT,
    });
    const out = String(
      await session.prompt(userMsg, { maxTokens: 200, temperature: 0.1, topP: 0.9 }),
    );
    const parsed = parseModelOutput(out);
    if (!parsed.ok || !parsed.verdict) {
      // Soft warn: prefer reject when the model is unparseable, but the
      // cascade caller can downgrade this to a flag if it wants.
      return {
        verdict: 'reject',
        reasoning: 'Semantic classifier output unparseable',
        confidence: 0.5,
      };
    }
    return {
      verdict: parsed.verdict.verdict,
      reasoning: parsed.verdict.reasoning,
      confidence: parsed.verdict.confidence,
    };
  } finally {
    await ctx.dispose();
  }
}

export function resetForTesting(): void {
  cached = null;
}
