// 20 archetypes. Every (mandate_summary, redemption, verdict) tuple is
// constructed deterministically; the generator can verify each archetype's
// invariant just by looking at the constructed scenario.

import type { Archetype, Scenario, VendorPick } from './types.js';
import {
  genNovelDomain,
  genPhishingDomain,
  pickAnyVendor,
  pickN,
  pickVendorAvoidingCategories,
  pickVendorByCategories,
  findParentSubdomainPair,
  randInt,
  pickOne,
  rand,
} from './registry.js';

function fmtUsdc(n: number): string {
  return `${n.toFixed(2)} USDC`;
}

function fmtAmount(n: number): string {
  return n.toFixed(2);
}

// helpers for ISO timestamps
function isoFuture(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86400_000);
  return d.toISOString();
}
function isoPast(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  return d.toISOString();
}

function fakeAddress(): string {
  const hex = '0123456789abcdef';
  let s = '0x';
  for (let i = 0; i < 40; i += 1) s += hex[Math.floor(rand() * 16)];
  return s;
}

const BUSINESS_CONSUMER_CATEGORIES = ['food-delivery', 'transit', 'gambling', 'retail-consumer', 'books'];

const ARCHETYPES: Archetype[] = [
  // ---------- APPROVES ----------

  {
    id: 'category_match_approve',
    verdict: 'approve',
    eval_category: 'obvious_approve',
    rule: 'category-match.approve',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(50, 500);
      const amount = +(rand() * (cap * 0.6) + 1).toFixed(2);
      const cat = pickOne(v.categories);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 20),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), cap: cap.toFixed(2), category: cat, vendor: v.name },
      };
    },
    reasoning_template: (s) =>
      `Category match: recipient_categories=[${(s.vendor as VendorPick).categories.join(',')}] matches intent authorizing ${s.vars.category}.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
      must_not_contain_keywords: ['forbid', 'except', 'never'],
    }),
  },

  {
    id: 'anchor_approve',
    verdict: 'approve',
    eval_category: 'obvious_approve',
    rule: 'anchor.approve',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(200, 2000);
      const amount = +(rand() * 30 + 1).toFixed(2);  // small relative to cap
      const cat = pickOne(v.categories);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(60, 365)),
          use_counter_remaining: randInt(10, 50),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), cap: cap.toFixed(2), category: cat, vendor: v.name },
      };
    },
    reasoning_template: (s) =>
      `Category match: recipient_categories=[${(s.vendor as VendorPick).categories.join(',')}] matches intent authorizing ${s.vars.category}; ${s.vars.vendor} is a canonical ${s.vars.category} vendor.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
      must_not_contain_keywords: ['forbid', 'except', 'never'],
    }),
  },

  {
    id: 'carve_out_approve',
    verdict: 'approve',
    eval_category: 'edge',
    rule: 'carve-out.approve',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(50, 500);
      const amount = +(rand() * (cap * 0.5) + 1).toFixed(2);
      const cat = pickOne(v.categories);
      const broaderForbid = pickOne(['marketing', 'productivity', 'crypto-defi', 'food-delivery']);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 180)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), category: cat, vendor: v.name, broaderForbid },
      };
    },
    reasoning_template: (s) =>
      `Explicit carve-out: intent forbids ${s.vars.broaderForbid} but explicitly allows ${s.vars.category}; recipient_categories=[${(s.vendor as VendorPick).categories.join(',')}] match the carve-out.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
      must_forbid_categories: [(s.vars.broaderForbid as string)],
      must_contain_keywords: ['except'],
    }),
  },

  {
    id: 'subdomain_child_approve',
    verdict: 'approve',
    eval_category: 'edge',
    rule: 'subdomain-child.approve',
    construct: () => {
      const { parent, child } = findParentSubdomainPair();
      const cap = randInt(50, 500);
      const amount = +(rand() * (cap * 0.4) + 1).toFixed(2);
      const childOnlyCat = (child.categories.find((c) => !parent.categories.includes(c)) ?? child.categories[0]) as string;
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 180)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: child.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(child.canonical_for),
        },
        vendor: child,
        vars: {
          amount: fmtAmount(amount),
          parent: parent.domain,
          parentName: parent.name,
          child: child.domain,
          childName: child.name,
          childOnlyCat,
        },
      };
    },
    reasoning_template: (s) =>
      `Subdomain carve-out: parent ${s.vars.parent} is broader-scope, but ${s.vars.child} (${(s.vendor as VendorPick).categories.join(',')}) covers ${s.vars.childOnlyCat} which intent authorizes.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.childOnlyCat as string)],
    }),
  },

  {
    id: 'tight_within_cap_approve',
    verdict: 'approve',
    eval_category: 'edge',
    rule: 'tight-within-cap.approve',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(20, 200);
      const amount = +(cap * (0.85 + rand() * 0.10)).toFixed(2); // 85-95% of cap
      const cat = pickOne(v.categories);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(7, 60)),
          use_counter_remaining: randInt(1, 5),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), cap: cap.toFixed(2), category: cat, vendor: v.name },
      };
    },
    reasoning_template: (s) =>
      `Within cap: amount $${s.vars.amount} ≤ spend_cap_remaining $${s.vars.cap}; category ${s.vars.category} authorized.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
    }),
  },

  {
    id: 'mandate_slack_approve',
    verdict: 'approve',
    eval_category: 'obvious_approve',
    rule: 'mandate-slack.approve',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(500, 5000);
      const amount = +(rand() * 20 + 0.5).toFixed(2);
      const cat = pickOne(v.categories);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(180, 730)),
          use_counter_remaining: randInt(50, 200),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), cap: cap.toFixed(2), category: cat, vendor: v.name },
      };
    },
    reasoning_template: (s) =>
      `Mandate slack: amount $${s.vars.amount} far below cap $${s.vars.cap}; category ${s.vars.category} authorized.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
    }),
  },

  // ---------- REJECTS — MANDATE STATE ----------

  {
    id: 'cap_exceeded',
    verdict: 'reject',
    eval_category: 'obvious_reject',
    rule: 'mandate-state.cap_exceeded',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(10, 200);
      const amount = +(cap * (1.05 + rand() * 0.5)).toFixed(2); // 105-155% of cap
      const cat = pickOne(v.categories);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(5, 20),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), cap: cap.toFixed(2), category: cat, vendor: v.name },
      };
    },
    reasoning_template: (s) =>
      `Cap exceeded: amount $${s.vars.amount} > spend_cap_remaining $${s.vars.cap}.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
    }),
  },

  {
    id: 'counter_exhausted',
    verdict: 'reject',
    eval_category: 'obvious_reject',
    rule: 'mandate-state.counter_exhausted',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(50, 500);
      const amount = +(rand() * 20 + 1).toFixed(2);
      const cat = pickOne(v.categories);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: 0,
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), category: cat, vendor: v.name },
      };
    },
    reasoning_template: () => 'Counter exhausted: use_counter_remaining = 0.',
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
    }),
  },

  {
    id: 'mandate_expired',
    verdict: 'reject',
    eval_category: 'obvious_reject',
    rule: 'mandate-state.expired',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(50, 500);
      const amount = +(rand() * 30 + 1).toFixed(2);
      const cat = pickOne(v.categories);
      const expired = isoPast(randInt(1, 90));
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: expired,
          use_counter_remaining: randInt(1, 10),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), category: cat, vendor: v.name, expiry: expired },
      };
    },
    reasoning_template: (s) => `Mandate expired: expiry_iso=${s.vars.expiry} is in the past.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
    }),
  },

  {
    id: 'zero_balance',
    verdict: 'reject',
    eval_category: 'obvious_reject',
    rule: 'mandate-state.zero_balance',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const amount = +(rand() * 20 + 0.5).toFixed(2);
      const cat = pickOne(v.categories);
      return {
        mandate_summary: {
          spend_cap_remaining: '0.00 USDC',
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(1, 10),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), category: cat, vendor: v.name },
      };
    },
    reasoning_template: (s) =>
      `Zero balance: spend_cap_remaining = $0.00, requested $${s.vars.amount}.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
    }),
  },

  {
    id: 'recipient_policy_explicit_block',
    verdict: 'reject',
    eval_category: 'obvious_reject',
    rule: 'mandate-state.recipient_policy_block',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(50, 500);
      const amount = +(rand() * 30 + 1).toFixed(2);
      const cat = pickOne(v.categories);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: `block:${v.domain}`,
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(1, 10),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), category: cat, vendor: v.name, blocked: v.domain },
      };
    },
    reasoning_template: (s) =>
      `Recipient blocked: recipient_policy excludes ${s.vars.blocked}.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
    }),
  },

  // ---------- REJECTS — SEMANTIC ----------

  {
    id: 'category_mismatch_reject',
    verdict: 'reject',
    eval_category: 'obvious_reject',
    rule: 'semantic.category_mismatch',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(50, 500);
      const amount = +(rand() * 30 + 1).toFixed(2);
      const vendorCat = pickOne(v.categories);
      // pick a clearly disjoint category for the intent
      const disjointPool = ['ml-inference', 'crypto-defi', 'food-delivery', 'gambling', 'electronics', 'transit'];
      const intentCat = pickOne(disjointPool.filter((c) => !v.categories.includes(c)));
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), vendorCat, intentCat, vendor: v.name },
      };
    },
    reasoning_template: (s) =>
      `Category mismatch: recipient_categories=[${(s.vendor as VendorPick).categories.join(',')}] does not match intent authorizing ${s.vars.intentCat}.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.intentCat as string)],
      must_not_contain_keywords: ['except', 'allow ' + (s.vars.vendorCat as string)],
    }),
  },

  {
    id: 'explicit_prohibition_reject',
    verdict: 'reject',
    eval_category: 'obvious_reject',
    rule: 'semantic.explicit_prohibition',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(50, 500);
      const amount = +(rand() * 30 + 1).toFixed(2);
      const vendorCat = pickOne(v.categories);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), vendorCat, vendor: v.name },
      };
    },
    reasoning_template: (s) =>
      `Explicit prohibition: intent forbids ${s.vars.vendorCat}; recipient_categories includes ${s.vars.vendorCat}.`,
    intent_constraints: (s) => ({
      must_forbid_categories: [(s.vars.vendorCat as string)],
    }),
  },

  {
    id: 'subdomain_parent_reject',
    verdict: 'reject',
    eval_category: 'edge',
    rule: 'semantic.subdomain_parent_reject',
    construct: () => {
      const { parent, child } = findParentSubdomainPair();
      const cap = randInt(50, 500);
      const amount = +(rand() * 30 + 1).toFixed(2);
      const childOnlyCat = (child.categories.find((c) => !parent.categories.includes(c)) ?? child.categories[0]) as string;
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: parent.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(parent.canonical_for),
        },
        vendor: parent,
        vars: {
          amount: fmtAmount(amount),
          parent: parent.domain,
          child: child.domain,
          childName: child.name,
          childOnlyCat,
          parentCats: parent.categories.join(','),
        },
      };
    },
    reasoning_template: (s) =>
      `Subdomain not allowed at parent: intent authorizes ${s.vars.child} (${s.vars.childOnlyCat}), but redemption is at parent ${s.vars.parent} with broader categories [${s.vars.parentCats}].`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.childOnlyCat as string)],
    }),
  },

  {
    id: 'personal_consumer_reject',
    verdict: 'reject',
    eval_category: 'obvious_reject',
    rule: 'semantic.personal_consumer',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(50, 500);
      const amount = +(rand() * 30 + 1).toFixed(2);
      const consumerCat = pickOne(v.categories.filter((c) => BUSINESS_CONSUMER_CATEGORIES.includes(c))) ?? v.categories[0];
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), consumerCat, vendor: v.name },
      };
    },
    reasoning_template: (s) =>
      `Personal consumer mismatch: recipient_categories=[${(s.vendor as VendorPick).categories.join(',')}] is consumer-class (${s.vars.consumerCat}); intent is business operations.`,
    intent_constraints: () => ({
      must_authorize_categories: ['cloud-compute', 'developer-tools'],
    }),
  },

  {
    id: 'financial_speculation_reject',
    verdict: 'reject',
    eval_category: 'obvious_reject',
    rule: 'semantic.financial_speculation',
    required_categories: ['gambling'],
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(50, 500);
      const amount = +(rand() * 30 + 1).toFixed(2);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), vendor: v.name },
      };
    },
    reasoning_template: (s) =>
      `Financial speculation: recipient_categories=[${(s.vendor as VendorPick).categories.join(',')}] is gambling/speculation; outside any operational intent.`,
    intent_constraints: () => ({
      must_authorize_categories: ['cloud-compute', 'developer-tools', 'productivity'],
      must_not_contain_keywords: ['gambl', 'bet', 'wager', 'speculat'],
    }),
  },

  {
    id: 'named_vendor_whitelist_miss',
    verdict: 'reject',
    eval_category: 'edge',
    rule: 'semantic.named_vendor_whitelist_miss',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      // pick a SAME-CATEGORY but DIFFERENT vendor as the named one
      const cat = pickOne(v.categories);
      let named: VendorPick;
      let attempts = 0;
      do {
        named = pickVendorByCategories([cat]);
        attempts += 1;
      } while (named.domain === v.domain && attempts < 8);
      const cap = randInt(50, 500);
      const amount = +(rand() * 30 + 1).toFixed(2);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: {
          amount: fmtAmount(amount),
          vendor: v.name,
          vendorDomain: v.domain,
          named: named.name,
          namedDomain: named.domain,
          category: cat,
        },
      };
    },
    reasoning_template: (s) =>
      `Whitelist miss: intent authorizes ${s.vars.named} specifically for ${s.vars.category}; redemption is to ${s.vars.vendor} (${s.vars.vendorDomain}), a different vendor.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
    }),
  },

  // ---------- EDGE — UNKNOWN VENDOR ----------

  {
    id: 'unknown_vendor_phishing',
    verdict: 'reject',
    eval_category: 'edge',
    rule: 'unknown.phishing',
    unknown_vendor: 'phishing',
    construct: () => {
      const { domain } = genPhishingDomain();
      const cap = randInt(50, 500);
      const amount = +(rand() * 30 + 1).toFixed(2);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(['claim your prize', 'verify your account', 'urgent payment']),
        },
        vendor: null,
        vars: { amount: fmtAmount(amount), domain },
      };
    },
    reasoning_template: (s) =>
      `Suspicious unknown vendor: ${s.vars.domain} matches phishing pattern; vendor_known=false; resource_description fits scam template.`,
    intent_constraints: () => ({
      must_authorize_categories: ['cloud-compute'],
      must_not_contain_keywords: ['claim', 'prize'],
    }),
  },

  {
    id: 'unknown_vendor_legitimate_novel',
    verdict: 'approve',
    eval_category: 'edge',
    rule: 'unknown.novel_legitimate',
    unknown_vendor: 'novel',
    construct: () => {
      const { domain, description_hint } = genNovelDomain();
      const cap = randInt(50, 500);
      const amount = +(rand() * (cap * 0.4) + 1).toFixed(2);
      const intentCat = pickOne(['cloud-compute', 'monitoring', 'observability', 'data-pipeline', 'developer-tools', 'ml-infra']);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: domain,
          amount_usdc: fmtAmount(amount),
          resource_description: description_hint,
        },
        vendor: null,
        vars: { amount: fmtAmount(amount), domain, hint: description_hint, category: intentCat },
      };
    },
    reasoning_template: (s) =>
      `Novel legitimate vendor: ${s.vars.domain} is unknown to registry but resource_description "${s.vars.hint}" aligns with intent's authorized ${s.vars.category}; approve with novelty flag.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
      must_contain_keywords: [(s.vars.hint as string).split(' ')[0] ?? ''],
    }),
  },

  {
    id: 'ambiguous_category_edge',
    verdict: 'approve',
    eval_category: 'edge',
    rule: 'edge.ambiguous_category',
    construct: () => {
      // pick vendors with >=2 categories
      const v = pickAnyVendor();
      const tries: VendorPick[] = [];
      for (let i = 0; i < 8; i += 1) {
        const cand = pickAnyVendor();
        if (cand.categories.length >= 2) { tries.push(cand); break; }
      }
      const vendor = tries[0] ?? v;
      const overlapCat = vendor.categories[0] as string;
      const cap = randInt(50, 500);
      const amount = +(rand() * (cap * 0.4) + 1).toFixed(2);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: vendor.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(vendor.canonical_for),
        },
        vendor,
        vars: {
          amount: fmtAmount(amount),
          vendor: vendor.name,
          overlapCat,
          allCats: vendor.categories.join(','),
        },
      };
    },
    reasoning_template: (s) =>
      `Ambiguous overlap: recipient_categories=[${s.vars.allCats}] partially match intent; ${s.vars.overlapCat} aligns and policy_intent does not exclude others.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.overlapCat as string)],
    }),
  },

  // Vendor's category surface-matches the intent, BUT the intent has an
  // explicit carve-out naming this specific vendor (or its slug). Tests
  // that the model honours specific exclusions over surface category match.
  {
    id: 'category_match_carve_out_reject',
    verdict: 'reject',
    eval_category: 'edge',
    rule: 'category-match.carve_out_reject',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cap = randInt(50, 500);
      const amount = +(rand() * (cap * 0.5) + 1).toFixed(2);
      const cat = pickOne(v.categories);
      const carvePhrase = pickOne([
        `except ${v.name}`,
        `but no ${v.name}`,
        `no ${v.domain}`,
        `excluding ${v.name}`,
        `${v.name} is not allowed`,
      ]);
      return {
        mandate_summary: {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        },
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), vendor: v.name, vendorDomain: v.domain, category: cat, carvePhrase },
      };
    },
    reasoning_template: (s) =>
      `Carve-out fires: intent authorizes ${s.vars.category} but explicitly excludes ${s.vars.vendor} via "${s.vars.carvePhrase}"; recipient_categories surface-match but the named-vendor carve-out overrides.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
      must_contain_keywords: [(s.vars.vendor as string).toLowerCase().split(/\W+/).filter(Boolean)[0] ?? ''],
    }),
  },

  // Vendor's category match is perfect, BUT mandate state independently
  // fails (cap / counter / expiry). Tests that the model checks mandate
  // state EVEN WHEN categories perfectly match.
  {
    id: 'category_match_mandate_state_reject',
    verdict: 'reject',
    eval_category: 'edge',
    rule: 'category-match.mandate_state_reject',
    construct: (vendor) => {
      const v = vendor as VendorPick;
      const cat = pickOne(v.categories);
      const failure = pickOne(['cap', 'counter', 'expiry']);
      let mandate: { spend_cap_remaining: string; recipient_policy: string; expiry_iso: string; use_counter_remaining: number };
      let amount: number;
      let detail: string;
      if (failure === 'cap') {
        const cap = randInt(10, 200);
        amount = +(cap * (1.05 + rand() * 0.5)).toFixed(2);
        mandate = {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: randInt(3, 15),
        };
        detail = `amount $${fmtAmount(amount)} > spend_cap_remaining $${cap.toFixed(2)}`;
      } else if (failure === 'counter') {
        const cap = randInt(50, 500);
        amount = +(rand() * 30 + 1).toFixed(2);
        mandate = {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: isoFuture(randInt(30, 365)),
          use_counter_remaining: 0,
        };
        detail = 'use_counter_remaining = 0';
      } else {
        const cap = randInt(50, 500);
        amount = +(rand() * 30 + 1).toFixed(2);
        const expired = isoPast(randInt(1, 90));
        mandate = {
          spend_cap_remaining: fmtUsdc(cap),
          recipient_policy: 'any',
          expiry_iso: expired,
          use_counter_remaining: randInt(1, 10),
        };
        detail = `expiry_iso=${expired} is in the past`;
      }
      return {
        mandate_summary: mandate,
        redemption: {
          recipient_address: fakeAddress(),
          recipient_domain: v.domain,
          amount_usdc: fmtAmount(amount),
          resource_description: pickOne(v.canonical_for),
        },
        vendor: v,
        vars: { amount: fmtAmount(amount), vendor: v.name, category: cat, failure, detail },
      };
    },
    reasoning_template: (s) =>
      `Mandate state fires before category check: ${s.vars.detail}; recipient_categories=[${(s.vendor as VendorPick).categories.join(',')}] would otherwise match intent authorizing ${s.vars.category}.`,
    intent_constraints: (s) => ({
      must_authorize_categories: [(s.vars.category as string)],
    }),
  },
];

export default ARCHETYPES;
