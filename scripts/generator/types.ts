// Shared types for the deterministic training-case generator.

import type { Case, MandateSummary, Redemption, Verdict } from '../../eval/schema.js';

export type EvalCategory = 'obvious_approve' | 'obvious_reject' | 'edge';

export interface VendorPick {
  domain: string;
  name: string;
  categories: string[];
  canonical_for: string[];
  fallback_parent?: string;          // for subdomain entries
}

export interface Scenario {
  mandate_summary: MandateSummary;
  redemption: Redemption;
  vendor: VendorPick | null;          // null only for unknown-vendor archetypes
  vars: Record<string, string | number | string[]>; // template substitution vars
}

export interface IntentConstraints {
  must_authorize_categories?: string[];
  must_forbid_categories?: string[];
  must_contain_keywords?: string[];
  must_not_contain_keywords?: string[];
}

export interface Archetype {
  id: string;                          // 'cap_exceeded'
  verdict: Verdict;
  eval_category: EvalCategory;
  rule: string;                        // human label, e.g. 'mandate-state.cap_exceeded'
  required_categories?: string[];      // narrow vendor selection
  unknown_vendor?: 'phishing' | 'novel' | 'none';
  construct: (vendor: VendorPick | null) => Scenario;
  reasoning_template: (s: Scenario) => string;
  intent_constraints: (s: Scenario) => IntentConstraints;
}

export type RawCase = Case & { _archetype: string };
