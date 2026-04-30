/**
 * Hybrid enforcement mapping — pure function, easy to unit-test.
 *
 * The 0.85 threshold is locked in HANDOFF-2.0.md; tweak the eval set, not
 * this number.
 */
import type { Verdict } from './parse.js';

export const HARD_REJECT_THRESHOLD = 0.85;

export type Enforcement = 'hard_reject' | 'soft_warn' | 'approve';

/**
 * Map a parsed verdict to an enforcement decision.
 *
 *   - approve → "approve" regardless of confidence; the model is voting yes.
 *   - reject + confidence >= 0.85 → "hard_reject"
 *   - reject + confidence <  0.85 → "soft_warn" (signed, but receipt is annotated)
 */
export function classify(verdict: Verdict): Enforcement {
  if (verdict.verdict === 'approve') return 'approve';
  return verdict.confidence >= HARD_REJECT_THRESHOLD ? 'hard_reject' : 'soft_warn';
}
