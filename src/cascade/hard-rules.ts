// Pure deterministic policy rules. Each function returns a RuleResult;
// runHardRules() executes them in order and returns the first that fires.
//
// All amount strings ("12.50" or "12.50 USDC") parse as floats.
// All comparisons are strict (> not >=).

import type {
  CascadeMandate,
  EnrichedRedemption,
  RuleResult,
} from '../cascade-types.js';

function parseUsdc(s: string | null | undefined): number {
  if (!s) return 0;
  const m = String(s).match(/^([\d.]+)/);
  return m ? Number(m[1]) : 0;
}

export function checkAbsoluteCapExceeded(
  mandate: CascadeMandate,
  redemption: EnrichedRedemption,
): RuleResult {
  if (!mandate.amount_max) {
    return {
      rule: 'absolute_cap_exceeded',
      fired: false,
      reason: 'No per-tx cap',
    };
  }
  const cap = parseUsdc(mandate.amount_max);
  const amount = parseUsdc(redemption.amount_usdc);
  const fired = amount > cap;
  return {
    rule: 'absolute_cap_exceeded',
    fired,
    reason: fired
      ? `Per-tx cap exceeded: $${amount.toFixed(2)} > amount_max $${cap.toFixed(2)}`
      : `Per-tx cap OK: $${amount.toFixed(2)} <= amount_max $${cap.toFixed(2)}`,
    field: 'amount_max',
    expected: cap,
    actual: amount,
  };
}

export function checkCapExceeded(
  mandate: CascadeMandate,
  redemption: EnrichedRedemption,
): RuleResult {
  const cap = parseUsdc(mandate.spend_cap_remaining);
  const amount = parseUsdc(redemption.amount_usdc);
  const fired = amount > cap;
  return {
    rule: 'cap_exceeded',
    fired,
    reason: fired
      ? `Cap exceeded: amount $${amount.toFixed(2)} > spend_cap_remaining $${cap.toFixed(2)}`
      : `Cap OK: amount $${amount.toFixed(2)} <= spend_cap_remaining $${cap.toFixed(2)}`,
    field: 'spend_cap_remaining',
    expected: cap,
    actual: amount,
  };
}

export function checkCounterExhausted(
  mandate: CascadeMandate,
  _redemption: EnrichedRedemption,
): RuleResult {
  const counter = mandate.use_counter_remaining;
  const fired = counter !== null && counter !== undefined && counter <= 0;
  return {
    rule: 'counter_exhausted',
    fired,
    reason: fired
      ? `Counter exhausted: use_counter_remaining = ${counter}`
      : `Counter OK: ${counter === null || counter === undefined ? 'unlimited' : counter} uses remaining`,
    field: 'use_counter_remaining',
    expected: '> 0',
    actual: counter,
  };
}

export function checkMandateExpired(
  mandate: CascadeMandate,
  _redemption?: EnrichedRedemption,
): RuleResult {
  if (!mandate.expiry_iso) {
    return { rule: 'mandate_expired', fired: false, reason: 'No expiry set' };
  }
  const expiry = new Date(mandate.expiry_iso);
  const now = new Date();
  const fired = !Number.isNaN(expiry.getTime()) && expiry < now;
  return {
    rule: 'mandate_expired',
    fired,
    reason: fired
      ? `Mandate expired: ${mandate.expiry_iso} < now (${now.toISOString()})`
      : `Mandate valid: expires ${mandate.expiry_iso}`,
    field: 'expiry_iso',
    expected: 'future',
    actual: mandate.expiry_iso,
  };
}

export function checkRecipientPolicyBlock(
  mandate: CascadeMandate,
  redemption: EnrichedRedemption,
): RuleResult {
  const policy = (mandate.recipient_policy ?? 'any').trim();
  if (policy === 'any') {
    return {
      rule: 'recipient_policy_explicit_block',
      fired: false,
      reason: 'Policy: any',
    };
  }
  const domain = (redemption.recipient_domain ?? '').toLowerCase();

  if (policy.startsWith('block:')) {
    const blocked = policy
      .slice('block:'.length)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const fired = blocked.some((b) => domain === b || domain.endsWith(`.${b}`));
    return {
      rule: 'recipient_policy_explicit_block',
      fired,
      reason: fired
        ? `Recipient policy blocks ${domain} (policy=${policy})`
        : `Recipient ${domain} not in block list`,
      field: 'recipient_policy',
      expected: `not in [${blocked.join(', ')}]`,
      actual: domain,
    };
  }

  if (policy.startsWith('allowlist:')) {
    const allowed = policy
      .slice('allowlist:'.length)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const fired = !allowed.some((a) => domain === a || domain.endsWith(`.${a}`));
    return {
      rule: 'recipient_policy_explicit_block',
      fired,
      reason: fired
        ? `Recipient ${domain} not in allowlist [${allowed.join(', ')}]`
        : `Recipient ${domain} in allowlist`,
      field: 'recipient_policy',
      expected: `in [${allowed.join(', ')}]`,
      actual: domain,
    };
  }

  return {
    rule: 'recipient_policy_explicit_block',
    fired: false,
    reason: `Policy unrecognized format: ${policy}`,
  };
}

export function checkUnknownVendorStrict(
  mandate: CascadeMandate,
  redemption: EnrichedRedemption,
): RuleResult {
  const strict = mandate.strict_unknown_policy === 'reject';
  const fired = strict && redemption.vendor_known === false;
  return {
    rule: 'unknown_vendor_strict_policy',
    fired,
    reason: fired
      ? 'Vendor unknown (not in registry) and strict_unknown_policy=reject'
      : 'Unknown vendor allowed under current policy',
    field: 'vendor_known',
    expected: 'true OR strict_unknown_policy != reject',
    actual: redemption.vendor_known,
  };
}

const PHISHING_PATTERNS: RegExp[] = [
  // login-bank.tk, verify-stripe.org, secure-aws.xyz, claim-prize-now.shop ...
  /^(login|verify|secure|account|update|claim|prize|urgent)-[\w-]+\.(net|org|info|biz|xyz|tk|shop|click|fun|ml|ga|cf)$/i,
  // stripe-verify-payment.net, okta-credentials-update.io, github-login-portal.org
  /^[\w-]+-(login|verify|secure|payment|update|credentials|portal)-?[\w-]*\.[\w-]+$/i,
  // win-1234-now.click, free-iphone-prize-42.xyz
  /^(win|free|claim|prize)-[\w-]+\.(click|fun|tk|ml|ga|cf|xyz)$/i,
  // bare suspicious-TLD domains
  /^[\w-]+\.(tk|ml|ga|cf)$/i,
];

export function checkPhishingDomain(
  _mandate: CascadeMandate,
  redemption: EnrichedRedemption,
): RuleResult {
  const domain = (redemption.recipient_domain ?? '').toLowerCase();
  if (!domain) {
    return {
      rule: 'phishing_domain_pattern',
      fired: false,
      reason: 'No domain to check',
    };
  }
  const fired = PHISHING_PATTERNS.some((p) => p.test(domain));
  return {
    rule: 'phishing_domain_pattern',
    fired,
    reason: fired
      ? `Domain ${domain} matches phishing pattern`
      : 'Domain pattern OK',
    field: 'recipient_domain',
    expected: 'no phishing markers',
    actual: domain,
  };
}

// Whitelist-miss: intent says "<vendor> only" or "exclusively <vendor>" or
// "approved vendors: A, B, C" — recipient must match one of the named vendors.
const NAMED_ONLY = /\b([\w-]+(?:\.[\w-]+)+)\s+only\b/i;
const EXCLUSIVELY = /\bexclusively\s+([\w-]+(?:\.[\w-]+)+)/i;
const APPROVED_LIST = /\bapproved\s+(?:vendors?|merchants?|recipients?)\s*[:=]\s*([^.]+)/i;

export function checkNamedVendorWhitelistMiss(
  _mandate: CascadeMandate,
  intent: string,
  redemption: EnrichedRedemption,
): RuleResult {
  const domain = (redemption.recipient_domain ?? '').toLowerCase();
  if (!domain) {
    return {
      rule: 'named_vendor_whitelist_miss',
      fired: false,
      reason: 'No domain to check',
    };
  }

  const checkMatch = (named: string): boolean => {
    const n = named.toLowerCase().replace(/[^a-z0-9.-]/g, '');
    if (!n) return false;
    return domain === n || domain.endsWith(`.${n}`) || n.endsWith(`.${domain}`);
  };

  const onlyMatch = intent.match(NAMED_ONLY);
  if (onlyMatch?.[1]) {
    const named = onlyMatch[1];
    const fired = !checkMatch(named);
    return {
      rule: 'named_vendor_whitelist_miss',
      fired,
      reason: fired
        ? `Intent specifies "${named} only" but redemption is to ${domain}`
        : `Recipient matches named vendor "${named}"`,
      field: 'intent',
      expected: named,
      actual: domain,
    };
  }
  const exclMatch = intent.match(EXCLUSIVELY);
  if (exclMatch?.[1]) {
    const named = exclMatch[1];
    const fired = !checkMatch(named);
    return {
      rule: 'named_vendor_whitelist_miss',
      fired,
      reason: fired
        ? `Intent specifies "exclusively ${named}" but redemption is to ${domain}`
        : `Recipient matches exclusive vendor "${named}"`,
      field: 'intent',
      expected: named,
      actual: domain,
    };
  }
  const listMatch = intent.match(APPROVED_LIST);
  if (listMatch?.[1]) {
    const named = listMatch[1]
      .split(/[,;]|\sand\s/i)
      .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9.-]/g, ''))
      .filter(Boolean);
    const fired = !named.some((n) => checkMatch(n));
    return {
      rule: 'named_vendor_whitelist_miss',
      fired,
      reason: fired
        ? `Intent has approved-vendor list [${named.join(', ')}] but redemption is to ${domain}`
        : `Recipient in approved-vendor list`,
      field: 'intent',
      expected: named.join(', '),
      actual: domain,
    };
  }

  return {
    rule: 'named_vendor_whitelist_miss',
    fired: false,
    reason: 'No named-vendor pattern in intent',
  };
}

// Cascade runner: executes rules in priority order, returns first that fires.
// Order: cheapest + highest-priority deterministic checks first.
export function runHardRules(
  mandate: CascadeMandate,
  intent: string,
  redemption: EnrichedRedemption,
): RuleResult | null {
  const ordered: Array<() => RuleResult> = [
    () => checkAbsoluteCapExceeded(mandate, redemption),
    () => checkCapExceeded(mandate, redemption),
    () => checkCounterExhausted(mandate, redemption),
    () => checkMandateExpired(mandate, redemption),
    () => checkRecipientPolicyBlock(mandate, redemption),
    () => checkUnknownVendorStrict(mandate, redemption),
    () => checkPhishingDomain(mandate, redemption),
    () => checkNamedVendorWhitelistMiss(mandate, intent, redemption),
  ];
  for (const run of ordered) {
    const r = run();
    if (r.fired) return r;
  }
  return null;
}
