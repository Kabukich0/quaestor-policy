// Cascade architecture types (Goldseel v0.3.0).
//
// The cascade replaces the single-pass model call with three stages:
//   1. vendor_lookup    — registry enrichment, always runs (cheap)
//   2. hard_rules       — deterministic rule checks, may decide reject
//   3. semantic_classifier — model call, only runs when no hard rule fired
//
// Verdict-determining checks (cap, counter, expiry, blocklist, phishing,
// allowlist) live in stage 2 as pure functions. The model is never asked
// to do arithmetic again.

import type { EnrichedRedemption, MandateSummary, Redemption, Verdict } from '../eval/schema.js';

export type RuleId =
  | 'cap_exceeded'
  | 'counter_exhausted'
  | 'mandate_expired'
  | 'absolute_cap_exceeded'
  | 'recipient_policy_explicit_block'
  | 'named_vendor_whitelist_miss'
  | 'phishing_domain_pattern'
  | 'unknown_vendor_strict_policy';

export interface RuleResult {
  rule: RuleId;
  fired: boolean;
  reason: string;
  field?: string;
  expected?: unknown;
  actual?: unknown;
}

export type CascadeStage = 'vendor_lookup' | 'hard_rules' | 'semantic_classifier';

// MandateSummary in eval/schema.ts has a smaller field set than the cascade
// rules need. Extend it with optional fields used by additional rules.
export interface CascadeMandate extends MandateSummary {
  amount_max?: string | null;
  strict_unknown_policy?: 'reject' | 'allow' | null;
}

export interface CascadeVerdict {
  verdict: Verdict;
  decided_at: CascadeStage;
  reasoning: string;
  rule_fired?: RuleId;
  confidence?: number;
  stages_run: CascadeStage[];
  latency_ms_per_stage: Partial<Record<CascadeStage, number>>;
  model_called: boolean;
}

export type { EnrichedRedemption, Redemption };
