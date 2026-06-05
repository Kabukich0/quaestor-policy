// Cascade orchestrator: runs vendor_lookup → hard_rules → semantic_classifier
// in order, short-circuits as soon as a hard rule fires.

import { enrichRedemption } from '@quaestor/vendor-registry';
import type {
  CascadeMandate,
  CascadeStage,
  CascadeVerdict,
  EnrichedRedemption,
  Redemption,
} from '../cascade-types.js';
import { runHardRules } from './hard-rules.js';
import { runSemanticClassifier } from './semantic-classifier.js';

export async function runCascade(
  mandate: CascadeMandate,
  intent: string,
  redemption: Redemption,
): Promise<CascadeVerdict> {
  const stages_run: CascadeStage[] = [];
  const latency_ms_per_stage: Partial<Record<CascadeStage, number>> = {};

  // Stage 1: vendor lookup (always cheap; needed for hard-rules + classifier).
  stages_run.push('vendor_lookup');
  const t1 = Date.now();
  const e = enrichRedemption({ recipient_domain: redemption.recipient_domain ?? '' });
  const enriched: EnrichedRedemption = {
    ...redemption,
    recipient_address: redemption.recipient_address ?? null,
    recipient_categories: e.recipient_categories,
    recipient_name: e.recipient_name,
    vendor_known: e.recipient_categories.length > 0,
  };
  latency_ms_per_stage.vendor_lookup = Date.now() - t1;

  // Stage 2: hard rules (deterministic).
  stages_run.push('hard_rules');
  const t2 = Date.now();
  const ruleResult = runHardRules(mandate, intent, enriched);
  latency_ms_per_stage.hard_rules = Date.now() - t2;

  if (ruleResult !== null) {
    return {
      verdict: 'reject',
      decided_at: 'hard_rules',
      reasoning: ruleResult.reason,
      rule_fired: ruleResult.rule,
      confidence: 1.0,
      stages_run,
      latency_ms_per_stage,
      model_called: false,
    };
  }

  // Stage 3: semantic classifier (model).
  stages_run.push('semantic_classifier');
  const t3 = Date.now();
  const semantic = await runSemanticClassifier(mandate, intent, enriched);
  latency_ms_per_stage.semantic_classifier = Date.now() - t3;

  return {
    verdict: semantic.verdict,
    decided_at: 'semantic_classifier',
    reasoning: semantic.reasoning,
    confidence: semantic.confidence,
    stages_run,
    latency_ms_per_stage,
    model_called: true,
  };
}
