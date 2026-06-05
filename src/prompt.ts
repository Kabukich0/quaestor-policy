/**
 * Prompt construction for the policy LLM (Goldseel v0.2.0).
 *
 * Single source of truth: the strings produced here MUST match the
 * user-message content emitted by training/finetune_modal.py:format_case().
 * If you change one, change the other and re-run scripts/verify-prompt-parity.ts.
 *
 * Output format: VERDICT (approve|reject) on the first line, then REASONING
 * on subsequent lines. The model emits plain text — no JSON envelope —
 * because the v0.2.0 training format is plain text. Parsing lives in src/parse.ts.
 */

import type { EnrichedRedemption, MandateSummary } from '../eval/schema.js';

export interface PromptInput {
  intent: string;
  mandate_summary: MandateSummary;
  redemption: EnrichedRedemption;
}

export const SYSTEM_PROMPT =
  "You are Quaestor's mandate enforcement classifier. You receive " +
  'an INTENT (the user-authorized purpose), a MANDATE_SUMMARY ' +
  '(spend cap, expiry, recipient policy, use counter), and a ' +
  'REDEMPTION (the proposed payment, including pre-classified ' +
  'recipient_categories from a vendor registry).\n\n' +
  'Your job: decide approve or reject based on three rules:\n' +
  '1. MANDATE STATE: if amount > spend_cap_remaining, or ' +
  'use_counter_remaining = 0, or expiry has passed, or ' +
  'recipient is explicitly disallowed by recipient_policy → reject.\n' +
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

/**
 * Build the user-message content. The key invariant: the JSON.stringify of
 * mandate_summary and redemption (in this exact field order) must match
 * what training/finetune_modal.py:format_case() emits, byte for byte.
 */
export function buildUserPrompt(input: PromptInput): string {
  const redemptionView = {
    recipient_domain: input.redemption.recipient_domain,
    recipient_name: input.redemption.recipient_name,
    recipient_categories: input.redemption.recipient_categories,
    vendor_known: input.redemption.vendor_known,
    amount_usdc: input.redemption.amount_usdc,
    resource_description: input.redemption.resource_description,
  };
  return (
    `INTENT: ${input.intent}\n` +
    `MANDATE_SUMMARY: ${JSON.stringify(input.mandate_summary)}\n` +
    `REDEMPTION: ${JSON.stringify(redemptionView)}`
  );
}

/** Retry on garbled output — same content, instructed to re-emit. */
export function buildRetryPrompt(input: PromptInput, badOutput: string): string {
  return (
    `${buildUserPrompt(input)}\n\n` +
    `Your previous reply was not in the expected format:\n${badOutput.slice(0, 400)}\n\n` +
    `Reply with two lines exactly:\nVERDICT: approve|reject\nREASONING: <one sentence>`
  );
}

// Re-exported for downstream callers that previously imported from here.
export type { MandateSummary, EnrichedRedemption };
