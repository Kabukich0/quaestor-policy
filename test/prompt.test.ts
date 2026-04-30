import { describe, expect, it } from 'vitest';
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, buildRetryPrompt, buildUserPrompt } from '../src/prompt.js';

const fixture = {
  intent: 'pay for SaaS hosting only',
  mandate_summary: {
    spend_cap_remaining: '50.00 USDC',
    recipient_policy: 'any',
    expiry_iso: '2026-12-31T23:59:59Z',
    use_counter_remaining: 5,
  },
  redemption: {
    recipient_address: '0xabc',
    recipient_domain: 'render.com',
    amount_usdc: '5.00',
    resource_description: 'render web service hosting',
  },
};

describe('buildUserPrompt', () => {
  it('includes intent verbatim', () => {
    const p = buildUserPrompt(fixture);
    expect(p).toContain('pay for SaaS hosting only');
  });

  it('includes recipient domain when supplied', () => {
    expect(buildUserPrompt(fixture)).toContain('render.com');
  });

  it('substitutes "(none)" when no domain', () => {
    const without = { ...fixture, redemption: { ...fixture.redemption, recipient_domain: undefined } };
    expect(buildUserPrompt(without)).toContain('recipient domain: (none)');
  });

  it('places intent after the redemption block (last attention bias)', () => {
    const p = buildUserPrompt(fixture);
    const intentIdx = p.indexOf('## Intent');
    const redemptionIdx = p.indexOf('## Redemption');
    expect(intentIdx).toBeGreaterThan(redemptionIdx);
  });
});

describe('buildRetryPrompt', () => {
  it('echoes the bad output', () => {
    const r = buildRetryPrompt(fixture, '{not-json');
    expect(r).toContain('{not-json');
  });

  it('truncates excessively long bad output', () => {
    const huge = 'x'.repeat(2000);
    const r = buildRetryPrompt(fixture, huge);
    expect(r.length).toBeLessThan(buildUserPrompt(fixture).length + 800);
  });
});

describe('SYSTEM_PROMPT and RESPONSE_SCHEMA', () => {
  it('system prompt names the three required output fields', () => {
    expect(SYSTEM_PROMPT).toContain('verdict');
    expect(SYSTEM_PROMPT).toContain('confidence');
    expect(SYSTEM_PROMPT).toContain('reasoning');
  });

  it('schema is closed (additionalProperties false)', () => {
    expect(RESPONSE_SCHEMA.additionalProperties).toBe(false);
  });
});
