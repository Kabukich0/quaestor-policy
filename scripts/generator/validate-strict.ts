// Strict per-case validator. Every check must pass; one failure = whole case bad.
//
// Usage: pnpm tsx scripts/generator/validate-strict.ts <path.jsonl>

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ARCHETYPES from './archetypes.js';
import type { RawCase } from './types.js';
import type { Case } from '../../eval/schema.js';
import { lookupVendor } from '@quaestor/vendor-registry';

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), '..', '..');

const inputArg = process.argv[2] ?? path.join(REPO, 'eval', 'training-cases-v0.2.0.jsonl');
const inputPath = path.isAbsolute(inputArg) ? inputArg : path.resolve(process.cwd(), inputArg);

const ARCHETYPE_BY_ID = new Map(ARCHETYPES.map((a) => [a.id, a] as const));

interface Failure { id: string; archetype: string; check: string; detail: string }

function parseUsdc(s: string): number {
  // accept "12.50 USDC" or "12.50"
  const m = s.match(/^([\d.]+)/);
  if (!m) return NaN;
  return Number(m[1]);
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function checkCase(raw: string, lineno: number): Failure[] {
  const fails: Failure[] = [];
  let c: RawCase;
  try { c = JSON.parse(raw); } catch (e) {
    return [{ id: `<line${lineno}>`, archetype: '?', check: 'json_parse', detail: (e as Error).message }];
  }
  const id = c.id ?? `<line${lineno}>`;
  const a = ARCHETYPE_BY_ID.get(c._archetype);
  if (!a) {
    fails.push({ id, archetype: c._archetype ?? '?', check: 'unknown_archetype', detail: c._archetype });
    return fails;
  }

  // 1. Required schema fields
  for (const f of ['id', 'category', 'intent', 'mandate_summary', 'redemption', 'expected_verdict', 'expected_reasoning'] as const) {
    if (c[f as keyof Case] === undefined || c[f as keyof Case] === null || c[f as keyof Case] === '') {
      fails.push({ id, archetype: a.id, check: 'missing_field', detail: f });
    }
  }
  if (c.expected_verdict !== a.verdict) {
    fails.push({ id, archetype: a.id, check: 'verdict_mismatch', detail: `expected ${a.verdict}, got ${c.expected_verdict}` });
  }
  if (c.category !== a.eval_category) {
    fails.push({ id, archetype: a.id, check: 'eval_category_mismatch', detail: `expected ${a.eval_category}, got ${c.category}` });
  }

  // 2. Mandate fields
  const m = c.mandate_summary;
  if (typeof m?.spend_cap_remaining !== 'string') fails.push({ id, archetype: a.id, check: 'mandate.spend_cap_remaining', detail: 'not string' });
  if (typeof m?.recipient_policy !== 'string') fails.push({ id, archetype: a.id, check: 'mandate.recipient_policy', detail: 'not string' });
  if (typeof m?.expiry_iso !== 'string') fails.push({ id, archetype: a.id, check: 'mandate.expiry_iso', detail: 'not string' });
  if (m?.use_counter_remaining !== null && typeof m?.use_counter_remaining !== 'number') {
    fails.push({ id, archetype: a.id, check: 'mandate.use_counter_remaining', detail: 'not number|null' });
  }

  // 3. Redemption fields
  const r = c.redemption;
  if (typeof r?.recipient_domain !== 'string') fails.push({ id, archetype: a.id, check: 'redemption.recipient_domain', detail: 'not string' });
  if (typeof r?.amount_usdc !== 'string') fails.push({ id, archetype: a.id, check: 'redemption.amount_usdc', detail: 'not string' });
  if (typeof r?.resource_description !== 'string') fails.push({ id, archetype: a.id, check: 'redemption.resource_description', detail: 'not string' });

  if (fails.length) return fails;

  // 4. Mandate-state invariants — the rule that should fire actually fires.
  const cap = parseUsdc(m.spend_cap_remaining);
  const amount = parseUsdc(r.amount_usdc);
  const expired = m.expiry_iso < new Date().toISOString();

  if (a.id === 'cap_exceeded' && !(amount > cap)) {
    fails.push({ id, archetype: a.id, check: 'invariant.cap_exceeded', detail: `amount ${amount} ≤ cap ${cap}` });
  }
  if (a.id === 'counter_exhausted' && m.use_counter_remaining !== 0) {
    fails.push({ id, archetype: a.id, check: 'invariant.counter_exhausted', detail: `counter=${m.use_counter_remaining}` });
  }
  if (a.id === 'mandate_expired' && !expired) {
    fails.push({ id, archetype: a.id, check: 'invariant.mandate_expired', detail: `expiry ${m.expiry_iso} not in past` });
  }
  if (a.id === 'zero_balance' && cap !== 0) {
    fails.push({ id, archetype: a.id, check: 'invariant.zero_balance', detail: `cap=${cap}` });
  }
  if (a.id === 'recipient_policy_explicit_block' && !m.recipient_policy.includes(r.recipient_domain)) {
    fails.push({ id, archetype: a.id, check: 'invariant.recipient_policy_block', detail: `policy=${m.recipient_policy} domain=${r.recipient_domain}` });
  }

  // 5. Approve archetypes that aren't supposed to hit any reject rule
  if (a.verdict === 'approve') {
    if (amount > cap) fails.push({ id, archetype: a.id, check: 'approve.under_cap_violated', detail: `${amount}>${cap}` });
    if (m.use_counter_remaining === 0) fails.push({ id, archetype: a.id, check: 'approve.counter_violated', detail: 'counter=0' });
    if (expired) fails.push({ id, archetype: a.id, check: 'approve.expiry_violated', detail: m.expiry_iso });
    if (m.recipient_policy.startsWith('block:')) fails.push({ id, archetype: a.id, check: 'approve.policy_block', detail: m.recipient_policy });
  }

  // 6. Vendor / registry check
  const lookup = lookupVendor(r.recipient_domain);
  if (a.unknown_vendor === 'phishing' || a.unknown_vendor === 'novel') {
    if (lookup !== null) {
      fails.push({ id, archetype: a.id, check: 'unknown_vendor.but_registry_hit', detail: `${r.recipient_domain} resolved to ${lookup.domain}` });
    }
  } else {
    if (!lookup) {
      fails.push({ id, archetype: a.id, check: 'vendor.registry_miss', detail: r.recipient_domain });
    }
  }

  // 7. Intent constraints. We re-run intent_constraints() with empty vars to get
  // the *archetype-level* keyword rules; per-scenario keyword rules (those that
  // depend on vars like vars.hint) can't be reconstructed from the case alone,
  // so we trust the generator's at-generation-time validation for those.
  let constraints: ReturnType<typeof a.intent_constraints> = {};
  try {
    constraints = a.intent_constraints({
      mandate_summary: m,
      redemption: r,
      vendor: a.unknown_vendor ? null : (lookup ? { domain: lookup.domain, name: lookup.name, categories: lookup.categories, canonical_for: lookup.canonical_for } : null),
      vars: {},
    });
  } catch {
    // archetype's intent_constraints needs scenario vars; skip keyword check
  }
  const intentLower = c.intent.toLowerCase();
  for (const k of constraints.must_contain_keywords ?? []) {
    if (!k) continue;
    if (!intentLower.includes(k.toLowerCase())) {
      fails.push({ id, archetype: a.id, check: 'intent.missing_keyword', detail: k });
    }
  }
  for (const k of constraints.must_not_contain_keywords ?? []) {
    if (!k) continue;
    if (intentLower.includes(k.toLowerCase())) {
      fails.push({ id, archetype: a.id, check: 'intent.contains_forbidden', detail: k });
    }
  }
  if (c.intent.length < 8 || c.intent.length > 240) {
    fails.push({ id, archetype: a.id, check: 'intent.length_oob', detail: `${c.intent.length} chars` });
  }

  // 8. Reasoning template match — exact equality with archetype's template applied to the same scenario
  // We re-run the template by reconstructing scenario from the case fields, but we don't have vars.
  // Instead, ensure the reasoning starts with the canonical prefix the archetype's template emits.
  const canonicalPrefix = canonicalReasoningPrefix(a.id);
  if (!c.expected_reasoning.startsWith(canonicalPrefix)) {
    fails.push({ id, archetype: a.id, check: 'reasoning.bad_prefix', detail: `got "${c.expected_reasoning.slice(0, 60)}", want prefix "${canonicalPrefix}"` });
  }

  // 9. ID must match content hash. Strip enrichment fields (added by
  // training/enrich.ts after generation) so the hash matches the
  // generator's original input.
  const r2 = { ...c.redemption } as Record<string, unknown>;
  delete r2.recipient_categories;
  delete r2.recipient_name;
  delete r2.vendor_known;
  const expectedId = shortHash(JSON.stringify({ intent: c.intent, mandate: c.mandate_summary, redemption: r2 }));
  if (c.id !== expectedId) {
    fails.push({ id, archetype: a.id, check: 'id.bad_hash', detail: `got ${c.id}, want ${expectedId}` });
  }

  return fails;
}

function canonicalReasoningPrefix(archetypeId: string): string {
  switch (archetypeId) {
    case 'category_match_approve':
    case 'anchor_approve': return 'Category match: ';
    case 'carve_out_approve': return 'Explicit carve-out: ';
    case 'subdomain_child_approve': return 'Subdomain carve-out: ';
    case 'tight_within_cap_approve': return 'Within cap: ';
    case 'mandate_slack_approve': return 'Mandate slack: ';
    case 'cap_exceeded': return 'Cap exceeded: ';
    case 'counter_exhausted': return 'Counter exhausted: ';
    case 'mandate_expired': return 'Mandate expired: ';
    case 'zero_balance': return 'Zero balance: ';
    case 'recipient_policy_explicit_block': return 'Recipient blocked: ';
    case 'category_mismatch_reject': return 'Category mismatch: ';
    case 'explicit_prohibition_reject': return 'Explicit prohibition: ';
    case 'subdomain_parent_reject': return 'Subdomain not allowed at parent: ';
    case 'personal_consumer_reject': return 'Personal consumer mismatch: ';
    case 'financial_speculation_reject': return 'Financial speculation: ';
    case 'named_vendor_whitelist_miss': return 'Whitelist miss: ';
    case 'unknown_vendor_phishing': return 'Suspicious unknown vendor: ';
    case 'unknown_vendor_legitimate_novel': return 'Novel legitimate vendor: ';
    case 'ambiguous_category_edge': return 'Ambiguous overlap: ';
    case 'category_match_carve_out_reject': return 'Carve-out fires: ';
    case 'category_match_mandate_state_reject': return 'Mandate state fires before category check: ';
    default: return '';
  }
}

const lines = readFileSync(inputPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
console.log(`validating ${lines.length} cases from ${path.relative(REPO, inputPath)}`);

const allFails: Failure[] = [];
const seenTuples = new Set<string>();
let dupes = 0;

for (let i = 0; i < lines.length; i += 1) {
  const fails = checkCase(lines[i] as string, i + 1);
  allFails.push(...fails);
  // duplicate detection on (intent, mandate, redemption)
  try {
    const c = JSON.parse(lines[i] as string);
    const key = JSON.stringify({ intent: c.intent, m: c.mandate_summary, r: c.redemption });
    if (seenTuples.has(key)) {
      allFails.push({ id: c.id, archetype: c._archetype, check: 'duplicate.tuple', detail: 'identical (intent, mandate, redemption)' });
      dupes += 1;
    }
    seenTuples.add(key);
  } catch { /* covered above */ }
}

const byCheck = new Map<string, number>();
for (const f of allFails) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);

console.log(`\nresult: ${lines.length - allFails.length}/${lines.length} pass`);
if (allFails.length === 0) {
  console.log('✓ all cases pass strict validation');
  process.exit(0);
}
console.log(`failures: ${allFails.length} (${dupes} duplicates)`);
console.log('\nby check:');
for (const [k, v] of [...byCheck.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)} ${k}`);
console.log('\nfirst 20:');
for (const f of allFails.slice(0, 20)) console.log(`  [${f.id}] ${f.archetype}/${f.check}: ${f.detail}`);
process.exit(1);
