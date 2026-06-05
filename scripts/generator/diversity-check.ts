// Diversity check on the generated cases.
//
// Targets:
//   - Top trigram frequency: < 2%
//   - Unique intent count:   ≥ 97% of total
//   - Unique (mandate_summary, redemption) tuples: ≥ 97% of total
//   - Categories used in redemptions: ≥ 40 of 53

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupVendor } from '@quaestor/vendor-registry';
import type { RawCase } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), '..', '..');

const inputArg = process.argv[2] ?? path.join(REPO, 'eval', 'training-cases-v0.2.0.jsonl');
const inputPath = path.isAbsolute(inputArg) ? inputArg : path.resolve(process.cwd(), inputArg);

const cases: RawCase[] = readFileSync(inputPath, 'utf8')
  .split('\n').filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

const total = cases.length;
console.log(`diversity-check: ${total} cases from ${path.relative(REPO, inputPath)}`);

// 1. Unique intents
const uniqueIntents = new Set(cases.map((c) => c.intent.toLowerCase().trim()));
const uniquePct = (uniqueIntents.size / total) * 100;
console.log(`\nunique intents: ${uniqueIntents.size}/${total} (${uniquePct.toFixed(1)}%) — target ≥ 97%`);

// 2. Unique (mandate, redemption) tuples
const uniqueTuples = new Set(cases.map((c) =>
  JSON.stringify({ m: c.mandate_summary, r: c.redemption })));
const tuplePct = (uniqueTuples.size / total) * 100;
console.log(`unique (mandate,redemption) tuples: ${uniqueTuples.size}/${total} (${tuplePct.toFixed(1)}%) — target ≥ 97%`);

// 3. Top trigram frequency over all intents
const trigrams = new Map<string, number>();
let tgTotal = 0;
for (const c of cases) {
  const tokens = c.intent.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length - 2; i += 1) {
    const tg = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
    trigrams.set(tg, (trigrams.get(tg) ?? 0) + 1);
    tgTotal += 1;
  }
}
const sortedTrigrams = [...trigrams.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\ntop 10 trigrams (of ${tgTotal} total trigram occurrences):`);
for (const [tg, n] of sortedTrigrams.slice(0, 10)) {
  console.log(`  ${((n / tgTotal) * 100).toFixed(2)}%  (${n}× / ${tgTotal})  "${tg}"`);
}
const topPct = sortedTrigrams[0] ? (sortedTrigrams[0][1] / tgTotal) * 100 : 0;
console.log(`top trigram: ${topPct.toFixed(2)}% — target < 2%`);

// 4. Categories used in redemptions
const cats = new Set<string>();
for (const c of cases) {
  const lookup = lookupVendor(c.redemption.recipient_domain);
  if (lookup) for (const cat of lookup.categories) cats.add(cat);
}
console.log(`\ncategories represented: ${cats.size}/53 — target ≥ 40`);

// 5. Per-archetype counts
console.log('\nper-archetype counts:');
const byArch = new Map<string, number>();
for (const c of cases) byArch.set(c._archetype, (byArch.get(c._archetype) ?? 0) + 1);
for (const [a, n] of [...byArch.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${a.padEnd(34)} ${n}`);
}

// Verdict ratio
const approves = cases.filter((c) => c.expected_verdict === 'approve').length;
const rejects = cases.filter((c) => c.expected_verdict === 'reject').length;
console.log(`\napprove/reject: ${approves}/${rejects} (${((rejects / total) * 100).toFixed(1)}% reject)`);

const ok = uniquePct >= 97 && tuplePct >= 97 && topPct < 2 && cats.size >= 40;
console.log(`\n${ok ? '✓ diversity targets met' : '✗ diversity targets NOT met'}`);
process.exit(ok ? 0 : 1);
