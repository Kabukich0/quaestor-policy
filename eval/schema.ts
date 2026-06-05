// Canonical case + redemption shapes shared by training and eval.
//
// Stage 2 (Goldseel v0.2.0) introduces the EnrichedRedemption shape.
// Every training and eval case is enriched with vendor-registry data
// BEFORE the classifier sees it — the classifier consumes only the
// EnrichedRedemption fields, never raw Redemption.

export type CaseCategory = 'obvious_approve' | 'obvious_reject' | 'edge';
export type Verdict = 'approve' | 'reject';

export interface MandateSummary {
  spend_cap_remaining: string;          // e.g. "75.00 USDC"
  recipient_policy: string;             // e.g. "any" | "domain:stripe.com" | "category:ml-inference"
  expiry_iso: string;
  use_counter_remaining: number | null; // null = unlimited
}

export interface Redemption {
  recipient_address: string | null;
  recipient_domain: string;
  amount_usdc: string;                  // string because existing data uses string ("12.00")
  resource_description: string;
}

export interface EnrichedRedemption extends Redemption {
  recipient_categories: string[];       // from vendor-registry; [] if unknown
  recipient_name: string | null;        // canonical display name; null if unknown
  vendor_known: boolean;                // false ⇔ recipient_categories.length === 0
}

export interface Case {
  id: string;
  category: CaseCategory | string;       // training cases use freeform strings
  intent: string;
  mandate_summary: MandateSummary;
  redemption: Redemption;
  expected_verdict: Verdict | '';
  expected_reasoning: string;
}

export interface EnrichedCase extends Omit<Case, 'redemption'> {
  redemption: EnrichedRedemption;
}
