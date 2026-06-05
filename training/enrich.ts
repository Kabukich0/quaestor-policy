// Enrich training/eval cases with recipient_categories + recipient_name
// from @quaestor/vendor-registry.
//
// Usage:
//   node --import tsx/esm training/enrich.ts --input <path> --output <path>
//
// Auto-detects format:
//   .jsonl  → line-delimited (training set)
//   .json   → array  (eval set)
//
// Side-effects:
//   - Strips _training_* metadata from top-level + mandate_summary + redemption
//   - Strips merchant_name from redemption (replaced by recipient_name from registry)
//   - Adds recipient_categories, recipient_name, vendor_known to redemption
//
// Output: same format as input, plus a vendor_known coverage report
// printed to stderr and the top-N unknown domains by frequency.

import { readFileSync, writeFileSync } from 'node:fs';
import { enrichRedemption } from '@quaestor/vendor-registry';
import type { Case, EnrichedCase, EnrichedRedemption } from '../eval/schema.js';

interface Args { input: string; output: string; topN: number }

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { topN: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') out.input = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--top-n') out.topN = Number(argv[++i]);
  }
  if (!out.input || !out.output) {
    console.error('usage: enrich.ts --input <path> --output <path> [--top-n 20]');
    process.exit(2);
  }
  return out as Args;
}

function stripTrainingMeta<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('_training_')) continue;
    out[k] = v;
  }
  return out as T;
}

export function enrichCase(c: Case): EnrichedCase {
  const e = enrichRedemption({ recipient_domain: c.redemption.recipient_domain ?? '' });
  const cleanedRedemption = stripTrainingMeta(c.redemption as Record<string, unknown>);
  delete (cleanedRedemption as Record<string, unknown>).merchant_name;
  const enrichedRedemption: EnrichedRedemption = {
    ...(cleanedRedemption as unknown as Redemption_),
    recipient_categories: e.recipient_categories,
    recipient_name: e.recipient_name,
    vendor_known: e.recipient_categories.length > 0,
  };
  const cleanedCase = stripTrainingMeta(c as unknown as Record<string, unknown>);
  cleanedCase.mandate_summary = stripTrainingMeta(c.mandate_summary as unknown as Record<string, unknown>);
  cleanedCase.redemption = enrichedRedemption;
  return cleanedCase as unknown as EnrichedCase;
}
type Redemption_ = EnrichedCase['redemption'];

function readInput(path: string): Case[] {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Case);
  }
  return JSON.parse(raw) as Case[];
}

function writeOutput(path: string, cases: EnrichedCase[]): void {
  if (path.endsWith('.jsonl')) {
    const body = cases.map((c) => JSON.stringify(c)).join('\n') + '\n';
    writeFileSync(path, body);
  } else {
    writeFileSync(path, JSON.stringify(cases, null, 2) + '\n');
  }
}

const isMain = process.argv[1]?.endsWith('enrich.ts') || process.argv[1]?.endsWith('enrich.js');

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const cases = readInput(args.input);
  const enriched: EnrichedCase[] = cases.map(enrichCase);
  writeOutput(args.output, enriched);

  const total = enriched.length;
  const known = enriched.filter((c) => c.redemption.vendor_known).length;
  const unknown = total - known;

  const unknownDomains = new Map<string, number>();
  for (const c of enriched) {
    if (!c.redemption.vendor_known) {
      const d = c.redemption.recipient_domain || '<empty>';
      unknownDomains.set(d, (unknownDomains.get(d) ?? 0) + 1);
    }
  }
  const top = [...unknownDomains.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, args.topN);

  process.stderr.write(`enriched ${total} → ${args.output}\n`);
  process.stderr.write(`  vendor_known true:  ${known} (${((known / total) * 100).toFixed(1)}%)\n`);
  process.stderr.write(`  vendor_known false: ${unknown} (${((unknown / total) * 100).toFixed(1)}%)\n`);
  process.stderr.write(`  unique unknown domains: ${unknownDomains.size}\n`);
  if (top.length) {
    process.stderr.write(`  top ${top.length} unknown domains by frequency:\n`);
    for (const [d, n] of top) process.stderr.write(`    ${String(n).padStart(4)}× ${d}\n`);
  }
}
