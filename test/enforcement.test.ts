import { describe, expect, it } from 'vitest';
import { HARD_REJECT_THRESHOLD, classify } from '../src/enforcement.js';

describe('classify', () => {
  it('approves on approve verdict regardless of confidence', () => {
    expect(classify({ verdict: 'approve', confidence: 0.5, reasoning: 'x' })).toBe('approve');
    expect(classify({ verdict: 'approve', confidence: 0.99, reasoning: 'x' })).toBe('approve');
  });

  it('hard-rejects when reject + confidence at threshold', () => {
    expect(classify({ verdict: 'reject', confidence: HARD_REJECT_THRESHOLD, reasoning: 'x' })).toBe(
      'hard_reject',
    );
  });

  it('hard-rejects when reject + confidence above threshold', () => {
    expect(classify({ verdict: 'reject', confidence: 0.99, reasoning: 'x' })).toBe('hard_reject');
  });

  it('soft-warns when reject + confidence just below threshold', () => {
    expect(classify({ verdict: 'reject', confidence: 0.84, reasoning: 'x' })).toBe('soft_warn');
  });

  it('soft-warns on low-confidence reject', () => {
    expect(classify({ verdict: 'reject', confidence: 0.3, reasoning: 'x' })).toBe('soft_warn');
  });

  it('threshold is exactly 0.85', () => {
    expect(HARD_REJECT_THRESHOLD).toBe(0.85);
  });
});
