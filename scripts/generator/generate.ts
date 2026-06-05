// Deterministic case generator. Pipelines:
//   archetype → vendor pick → scenario construct → LLM intent → reasoning template → strict validate → emit
//
// Output: eval/training-cases-v0.2.0.jsonl (raw, pre-enrichment)

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ARCHETYPES from './archetypes.js';
import { generateIntents } from './intent-gen.js';
import {
  pickAnyVendor,
  pickVendorAvoidingCategories,
  pickVendorByCategories,
  rand,
  seedRng,
} from './registry.js';
import type { Archetype, RawCase, Scenario, VendorPick } from './types.js';
import type { Case } from '../../eval/schema.js';

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), '..', '..');

// CLI: --only <a,b,c> filters TARGETS; --out <path> overrides default output.
const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const outIdx = argv.indexOf('--out');
const onlyArchetypes = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null;
const OUT_PATH = outIdx >= 0
  ? path.resolve(argv[outIdx + 1] as string)
  : path.join(REPO, 'eval', 'training-cases-v0.2.0.jsonl');

seedRng(Number(process.env.SEED ?? '1337'));

const ALL_TARGETS: Record<string, number> = {
  category_match_approve: 300,
  anchor_approve: 250,
  carve_out_approve: 100,
  subdomain_child_approve: 50,
  tight_within_cap_approve: 80,
  mandate_slack_approve: 50,
  cap_exceeded: 80,
  counter_exhausted: 60,
  mandate_expired: 60,
  zero_balance: 40,
  recipient_policy_explicit_block: 30,
  category_mismatch_reject: 70,
  explicit_prohibition_reject: 50,
  subdomain_parent_reject: 50,
  personal_consumer_reject: 50,
  financial_speculation_reject: 30,
  named_vendor_whitelist_miss: 50,
  unknown_vendor_phishing: 50,
  unknown_vendor_legitimate_novel: 30,
  ambiguous_category_edge: 20,
  category_match_carve_out_reject: 100,
  category_match_mandate_state_reject: 80,
};
const TARGETS: Record<string, number> = onlyArchetypes
  ? Object.fromEntries(onlyArchetypes.map((id) => [id, ALL_TARGETS[id] ?? 0]))
  : ALL_TARGETS;

const TOTAL = Object.values(TARGETS).reduce((a, b) => a + b, 0);
console.log(`generator: target ${TOTAL} cases across ${Object.keys(TARGETS).length} archetypes`);
for (const [a, n] of Object.entries(TARGETS)) console.log(`  ${a.padEnd(34)} ${n}`);

// quick lookup
const ARCHETYPE_BY_ID = new Map(ARCHETYPES.map((a) => [a.id, a] as const));
for (const id of Object.keys(TARGETS)) {
  if (!ARCHETYPE_BY_ID.has(id)) throw new Error(`target archetype ${id} not in ARCHETYPES`);
}

function pickVendorForArchetype(a: Archetype): VendorPick | null {
  if (a.unknown_vendor) return null;
  if (a.required_categories?.length) {
    return pickVendorByCategories(a.required_categories);
  }
  if (a.id === 'subdomain_child_approve' || a.id === 'subdomain_parent_reject') {
    // construct() calls findParentSubdomainPair() itself; vendor passed in is unused.
    return pickAnyVendor();
  }
  if (a.id === 'personal_consumer_reject') {
    return pickVendorByCategories(['food-delivery', 'gambling', 'retail-consumer', 'transit', 'books']);
  }
  if (a.id === 'category_mismatch_reject') {
    return pickAnyVendor();
  }
  if (a.id === 'unknown_vendor_phishing' || a.id === 'unknown_vendor_legitimate_novel') {
    return null;
  }
  // Default: pick any vendor
  return pickAnyVendor();
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function caseId(intent: string, mandate: object, redemption: object): string {
  return shortHash(JSON.stringify({ intent, mandate, redemption }));
}

interface BuiltScenario {
  scenario: Scenario;
  reasoning: string;
  archetype: Archetype;
  _consumed?: boolean;
}

function buildScenario(a: Archetype): BuiltScenario | null {
  try {
    const vendor = pickVendorForArchetype(a);
    const scenario = a.construct(vendor);
    const reasoning = a.reasoning_template(scenario);
    return { scenario, reasoning, archetype: a };
  } catch (e) {
    return null;
  }
}

const cases: RawCase[] = [];
const seenIds = new Set<string>();
const seenIntents = new Set<string>();

let archetypeIndex = 0;
for (const [archetypeId, target] of Object.entries(TARGETS)) {
  archetypeIndex += 1;
  if (archetypeIndex > 1) {
    process.stderr.write(`  [breather] sleeping 5s between archetypes…\n`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  const a = ARCHETYPE_BY_ID.get(archetypeId) as Archetype;
  console.log(`\n=== ${archetypeId} (target ${target}) ===`);

  // Pick a small pool of unique vendors and bunch cases per vendor.
  // K = pool size; perVendor = how many scenarios per vendor.
  const K = Math.min(Math.max(8, Math.ceil(target / 15)), 30);
  const perVendor = Math.ceil(target * 1.4 / K);
  const groups = new Map<string, BuiltScenario[]>();
  let attempts = 0;
  while (groups.size < K && attempts < K * 8) {
    attempts += 1;
    const built = buildScenario(a);
    if (!built) continue;
    const key = built.scenario.vendor?.domain ?? `__unknown_${attempts}_${a.id}`;
    if (groups.has(key)) continue;
    groups.set(key, [built]);
  }
  // fill each vendor group with additional scenarios for that same vendor
  for (const [key, list] of groups) {
    while (list.length < perVendor) {
      const built = buildScenario(a);
      if (!built) break;
      const sameVendor = built.scenario.vendor?.domain === key || (a.unknown_vendor && key.startsWith('__unknown_'));
      if (!sameVendor) continue;
      list.push(built);
    }
  }
  const totalScenarios = [...groups.values()].reduce((acc, g) => acc + g.length, 0);
  console.log(`  pool: ${groups.size} vendors × avg ${(totalScenarios / Math.max(1, groups.size)).toFixed(1)} scenarios`);

  let accepted = 0;
  let pass = 0;
  while (accepted < target && pass < 4) {
    pass += 1;
    for (const [key, group] of groups) {
      if (accepted >= target) break;
      // Find scenarios in this group not yet consumed
      const remaining = group.filter((g) => !g._consumed);
      if (remaining.length === 0) continue;
      const need = Math.min(remaining.length, target - accepted);
      if (need === 0) continue;

      const probe = remaining[0] as BuiltScenario;
      const intents = await generateIntents(
        a,
        probe.scenario.vendor,
        probe.scenario,
        need,
      );

      for (let i = 0; i < remaining.length && i < intents.length && accepted < target; i += 1) {
        const built = remaining[i] as BuiltScenario;
        const intent = intents[i] as string;
        built._consumed = true;
        const lower = intent.toLowerCase();
        if (seenIntents.has(lower)) continue;

        const id = caseId(intent, built.scenario.mandate_summary, built.scenario.redemption);
        if (seenIds.has(id)) continue;

      const c: RawCase = {
        id,
        category: a.eval_category,
        intent,
        mandate_summary: built.scenario.mandate_summary,
        redemption: built.scenario.redemption,
        expected_verdict: a.verdict,
        expected_reasoning: built.reasoning,
        _archetype: a.id,
      };
      cases.push(c);
      seenIds.add(id);
      seenIntents.add(lower);
      accepted += 1;
    }
    process.stdout.write(`  pass ${pass}: ${accepted}/${target}\r`);
  }
    if (accepted < target) {
      // refill scenarios for any vendor that ran dry
      for (const [key, list] of groups) {
        const fresh = list.filter((g) => !g._consumed);
        while (fresh.length < perVendor) {
          const built = buildScenario(a);
          if (!built) break;
          const sameVendor = built.scenario.vendor?.domain === key || (a.unknown_vendor && key.startsWith('__unknown_'));
          if (!sameVendor) continue;
          list.push(built);
          fresh.push(built);
        }
      }
    }
  }
  process.stdout.write(`\n  accepted: ${accepted}/${target}\n`);
}

console.log(`\ngenerator: ${cases.length}/${TOTAL} cases produced`);
writeFileSync(OUT_PATH, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(`wrote ${path.relative(REPO, OUT_PATH)}`);
