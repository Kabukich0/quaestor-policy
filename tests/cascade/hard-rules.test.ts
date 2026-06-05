import { describe, it, expect } from 'vitest';
import {
  checkCapExceeded,
  checkCounterExhausted,
  checkMandateExpired,
  checkAbsoluteCapExceeded,
  checkRecipientPolicyBlock,
  checkNamedVendorWhitelistMiss,
  checkPhishingDomain,
  checkUnknownVendorStrict,
  runHardRules,
} from '../../src/cascade/hard-rules.js';
import type { CascadeMandate, EnrichedRedemption } from '../../src/cascade-types.js';

const M = (overrides: Partial<CascadeMandate> = {}): CascadeMandate => ({
  spend_cap_remaining: '100.00 USDC',
  recipient_policy: 'any',
  expiry_iso: '2099-12-31T23:59:59Z',
  use_counter_remaining: 5,
  ...overrides,
});
const R = (overrides: Partial<EnrichedRedemption> = {}): EnrichedRedemption => ({
  recipient_address: '0xabc',
  recipient_domain: 'stripe.com',
  amount_usdc: '50.00',
  resource_description: 'test',
  recipient_categories: ['payments'],
  recipient_name: 'Stripe',
  vendor_known: true,
  ...overrides,
});

describe('cap_exceeded', () => {
  it('fires when amount > spend_cap_remaining', () => {
    const r = checkCapExceeded(M({ spend_cap_remaining: '50.00' }), R({ amount_usdc: '60.00' }));
    expect(r.fired).toBe(true);
    expect(r.reason).toContain('60.00');
    expect(r.reason).toContain('50.00');
  });
  it('does not fire when amount <= cap', () => {
    expect(checkCapExceeded(M({ spend_cap_remaining: '100' }), R({ amount_usdc: '99.99' })).fired).toBe(false);
  });
  it('handles tight equality (== is not >)', () => {
    expect(checkCapExceeded(M({ spend_cap_remaining: '50' }), R({ amount_usdc: '50' })).fired).toBe(false);
  });
  it('parses USDC suffix', () => {
    expect(checkCapExceeded(M({ spend_cap_remaining: '50.00 USDC' }), R({ amount_usdc: '60.00' })).fired).toBe(true);
  });
});

describe('counter_exhausted', () => {
  it('fires when use_counter_remaining = 0', () => {
    expect(checkCounterExhausted(M({ use_counter_remaining: 0 }), R()).fired).toBe(true);
  });
  it('does not fire when counter is null (unlimited)', () => {
    expect(checkCounterExhausted(M({ use_counter_remaining: null }), R()).fired).toBe(false);
  });
  it('does not fire when counter > 0', () => {
    expect(checkCounterExhausted(M({ use_counter_remaining: 5 }), R()).fired).toBe(false);
  });
});

describe('mandate_expired', () => {
  it('fires when expiry_iso is in the past', () => {
    expect(checkMandateExpired(M({ expiry_iso: '2020-01-01T00:00:00Z' }), R()).fired).toBe(true);
  });
  it('does not fire when expiry is in the future', () => {
    expect(checkMandateExpired(M({ expiry_iso: '2099-12-31T23:59:59Z' }), R()).fired).toBe(false);
  });
});

describe('absolute_cap_exceeded', () => {
  it('fires when amount > amount_max', () => {
    expect(checkAbsoluteCapExceeded(M({ amount_max: '20.00' }), R({ amount_usdc: '50.00' })).fired).toBe(true);
  });
  it('does not fire when amount_max is unset', () => {
    expect(checkAbsoluteCapExceeded(M(), R({ amount_usdc: '999' })).fired).toBe(false);
  });
});

describe('recipient_policy_explicit_block', () => {
  it('fires when domain is in block list', () => {
    expect(
      checkRecipientPolicyBlock(M({ recipient_policy: 'block:canva.com,figma.com' }), R({ recipient_domain: 'canva.com' })).fired,
    ).toBe(true);
  });
  it('fires when domain is NOT in allowlist', () => {
    expect(
      checkRecipientPolicyBlock(
        M({ recipient_policy: 'allowlist:stripe.com,modal.com' }),
        R({ recipient_domain: 'coinbase.com' }),
      ).fired,
    ).toBe(true);
  });
  it('does not fire when policy is "any"', () => {
    expect(checkRecipientPolicyBlock(M({ recipient_policy: 'any' }), R({ recipient_domain: 'x.com' })).fired).toBe(false);
  });
  it('subdomain is blocked when parent is in block list', () => {
    expect(
      checkRecipientPolicyBlock(
        M({ recipient_policy: 'block:stripe.com' }),
        R({ recipient_domain: 'api.stripe.com' }),
      ).fired,
    ).toBe(true);
  });
});

describe('phishing_domain_pattern', () => {
  it('fires on login-bank.tk', () => {
    expect(checkPhishingDomain(M(), R({ recipient_domain: 'login-bank.tk' })).fired).toBe(true);
  });
  it('fires on stripe-verify-payment.net', () => {
    expect(checkPhishingDomain(M(), R({ recipient_domain: 'stripe-verify-payment.net' })).fired).toBe(true);
  });
  it('fires on okta-login-portal.org', () => {
    expect(checkPhishingDomain(M(), R({ recipient_domain: 'okta-login-portal.org' })).fired).toBe(true);
  });
  it('does not fire on legitimate stripe.com', () => {
    expect(checkPhishingDomain(M(), R({ recipient_domain: 'stripe.com' })).fired).toBe(false);
  });
  it('does not fire on legitimate okta.com', () => {
    expect(checkPhishingDomain(M(), R({ recipient_domain: 'okta.com' })).fired).toBe(false);
  });
});

describe('named_vendor_whitelist_miss', () => {
  it('fires when intent says "stripe.com only" but redemption is to adyen.com', () => {
    expect(
      checkNamedVendorWhitelistMiss(M(), 'stripe.com only for payments', R({ recipient_domain: 'adyen.com' })).fired,
    ).toBe(true);
  });
  it('does not fire when intent says "stripe.com only" and redemption matches', () => {
    expect(
      checkNamedVendorWhitelistMiss(M(), 'stripe.com only for payments', R({ recipient_domain: 'stripe.com' })).fired,
    ).toBe(false);
  });
  it('does not fire when there is no named-vendor pattern', () => {
    expect(
      checkNamedVendorWhitelistMiss(M(), 'any payment vendor', R({ recipient_domain: 'adyen.com' })).fired,
    ).toBe(false);
  });
});

describe('unknown_vendor_strict_policy', () => {
  it('fires when strict_unknown_policy=reject and vendor_known=false', () => {
    expect(
      checkUnknownVendorStrict(M({ strict_unknown_policy: 'reject' }), R({ vendor_known: false })).fired,
    ).toBe(true);
  });
  it('does not fire when vendor_known=true', () => {
    expect(
      checkUnknownVendorStrict(M({ strict_unknown_policy: 'reject' }), R({ vendor_known: true })).fired,
    ).toBe(false);
  });
  it('does not fire when policy is not strict', () => {
    expect(checkUnknownVendorStrict(M(), R({ vendor_known: false })).fired).toBe(false);
  });
});

describe('runHardRules', () => {
  it('returns null when no rule fires', () => {
    expect(runHardRules(M(), 'any', R())).toBeNull();
  });
  it('fires absolute_cap_exceeded before cap_exceeded', () => {
    const r = runHardRules(M({ amount_max: '5.00', spend_cap_remaining: '500' }), 'any', R({ amount_usdc: '20' }));
    expect(r?.rule).toBe('absolute_cap_exceeded');
  });
  it('fires cap_exceeded when amount exceeds remaining', () => {
    const r = runHardRules(M({ spend_cap_remaining: '10' }), 'any', R({ amount_usdc: '50' }));
    expect(r?.rule).toBe('cap_exceeded');
  });
  it('fires phishing on login-bank.tk', () => {
    const r = runHardRules(M(), 'any', R({ recipient_domain: 'login-bank.tk', vendor_known: false }));
    expect(r?.rule).toBe('phishing_domain_pattern');
  });
});
