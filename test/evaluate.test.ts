import { describe, expect, it } from 'vitest';
import { EvaluateInputSchema, evaluateRedemption, resetForTesting } from '../src/evaluate.js';

describe('evaluateRedemption (no model)', () => {
  it('short-circuits on empty intent without loading the model', async () => {
    resetForTesting();
    const out = await evaluateRedemption({
      intent: '',
      mandate_summary: {
        spend_cap_remaining: '50.00',
        recipient_policy: 'any',
        expiry_iso: '2026-12-31T00:00:00Z',
        use_counter_remaining: 1,
      },
      redemption: {
        recipient_address: '0xabc',
        amount_usdc: '1.00',
      },
    });
    expect(out.verdict).toBe('approve');
    expect(out.confidence).toBe(1.0);
    expect(out.enforcement).toBe('approve');
  });

  it('rejects malformed input via zod', () => {
    expect(() =>
      EvaluateInputSchema.parse({
        intent: 'x',
        mandate_summary: { spend_cap_remaining: 1, recipient_policy: 'a', expiry_iso: 'b', use_counter_remaining: -1 },
        redemption: { recipient_address: 'a', amount_usdc: 'b' },
      }),
    ).toThrow();
  });
});
