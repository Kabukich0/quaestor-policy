import { describe, expect, it } from 'vitest';
import { parseModelOutput } from '../src/parse.js';

describe('parseModelOutput', () => {
  it('parses a clean JSON object', () => {
    const r = parseModelOutput(
      '{"verdict":"approve","confidence":0.92,"reasoning":"hosting matches intent"}',
    );
    expect(r.ok).toBe(true);
    expect(r.verdict?.verdict).toBe('approve');
    expect(r.verdict?.confidence).toBeCloseTo(0.92);
  });

  it('strips ```json fences', () => {
    const r = parseModelOutput(
      '```json\n{"verdict":"reject","confidence":0.9,"reasoning":"clearly contradicts"}\n```',
    );
    expect(r.ok).toBe(true);
    expect(r.verdict?.verdict).toBe('reject');
  });

  it('handles leading prose by extracting first/last brace', () => {
    const r = parseModelOutput(
      'Sure, here is my answer:\n{"verdict":"approve","confidence":0.7,"reasoning":"plausible"}\nDone.',
    );
    expect(r.ok).toBe(true);
    expect(r.verdict?.verdict).toBe('approve');
  });

  it('rejects bad confidence', () => {
    const r = parseModelOutput('{"verdict":"approve","confidence":1.5,"reasoning":"x"}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/schema/);
  });

  it('rejects unknown verdict literal', () => {
    const r = parseModelOutput('{"verdict":"maybe","confidence":0.5,"reasoning":"x"}');
    expect(r.ok).toBe(false);
  });

  it('rejects empty input', () => {
    const r = parseModelOutput('');
    expect(r.ok).toBe(false);
  });

  it('rejects malformed JSON', () => {
    const r = parseModelOutput('{verdict:approve}');
    expect(r.ok).toBe(false);
  });

  it('rejects when reasoning is empty', () => {
    const r = parseModelOutput('{"verdict":"approve","confidence":0.9,"reasoning":""}');
    expect(r.ok).toBe(false);
  });
});
