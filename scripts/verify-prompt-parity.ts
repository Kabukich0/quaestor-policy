// Verify the user-message content produced by training/finetune_modal.py
// matches what src/prompt.ts:buildUserPrompt() emits, byte for byte. Also
// verify the Stage 3 cascade SYSTEM_PROMPT matches the training one — the
// model was fine-tuned against that exact byte-stream and any drift will
// silently regress recall.
//
// We re-implement format_case() here in TS using the EXACT field order
// from finetune_modal.py and diff against buildUserPrompt(). Both must
// produce identical strings for every case.
//
// Usage:
//   node --import tsx/esm scripts/verify-prompt-parity.ts

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUserPrompt } from '../src/prompt.js';
import { SEMANTIC_SYSTEM_PROMPT } from '../src/cascade/semantic-classifier.js';
import type { EnrichedCase } from '../eval/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');

// Mirror of finetune_modal.py:format_case() user-message construction.
// json.dumps(d) in Python with default settings emits the same byte-stream
// as JSON.stringify(d) in JS — IF input dicts iterate in insertion order
// (Python 3.7+ dict preserves insertion order; JS Object too).
function trainingUserMessage(c: EnrichedCase): string {
  const mandate = c.mandate_summary;
  const r = c.redemption;
  const redemption_view = {
    recipient_domain: r.recipient_domain,
    recipient_name: r.recipient_name,
    recipient_categories: r.recipient_categories,
    vendor_known: r.vendor_known,
    amount_usdc: r.amount_usdc,
    resource_description: r.resource_description,
  };
  return (
    `INTENT: ${c.intent}\n` +
    `MANDATE_SUMMARY: ${JSON.stringify(mandate)}\n` +
    `REDEMPTION: ${JSON.stringify(redemption_view)}`
  );
}

function evalUserMessage(c: EnrichedCase): string {
  return buildUserPrompt({
    intent: c.intent,
    mandate_summary: c.mandate_summary,
    redemption: c.redemption,
  });
}

// Reconstruct training SYSTEM_PROMPT by parsing finetune_modal.py. We pull
// the literal between `SYSTEM_PROMPT = (` and the matching `)` and concat
// the Python string fragments. If finetune_modal.py is reformatted the
// regex may need updating; the test will fail loudly rather than silently.
function trainingSystemPrompt(): string {
  const src = readFileSync(path.join(REPO, 'training', 'finetune_modal.py'), 'utf8');
  const m = src.match(/SYSTEM_PROMPT\s*=\s*\(([\s\S]*?)\)\n/);
  if (!m) throw new Error('SYSTEM_PROMPT block not found in finetune_modal.py');
  const body = m[1];
  const fragments = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((mm) =>
    mm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
  );
  return fragments.join('');
}

const cases: EnrichedCase[] = JSON.parse(
  readFileSync(path.join(REPO, 'eval', 'cases-v0.2.0-enriched.json'), 'utf8'),
);

let mismatches = 0;
let firstSample: { id: string; train: string; evaL: string } | null = null;

for (const c of cases) {
  const t = trainingUserMessage(c);
  const e = evalUserMessage(c);
  if (t !== e) {
    mismatches += 1;
    if (!firstSample) firstSample = { id: c.id, train: t, evaL: e };
  }
}

console.log(`compared ${cases.length} cases`);
console.log(`  user-message mismatches: ${mismatches}`);

const trainingSys = trainingSystemPrompt();
const sysOk = trainingSys === SEMANTIC_SYSTEM_PROMPT;
console.log(`  system-prompt parity: ${sysOk ? '✓' : '✗'}`);
if (!sysOk) {
  console.log(`    training len=${trainingSys.length} cascade len=${SEMANTIC_SYSTEM_PROMPT.length}`);
  // Find first diverging char
  const n = Math.min(trainingSys.length, SEMANTIC_SYSTEM_PROMPT.length);
  let i = 0;
  while (i < n && trainingSys[i] === SEMANTIC_SYSTEM_PROMPT[i]) i += 1;
  console.log(`    first diverge @ index ${i}`);
  console.log(`    training: ${JSON.stringify(trainingSys.slice(Math.max(0, i - 20), i + 40))}`);
  console.log(`    cascade : ${JSON.stringify(SEMANTIC_SYSTEM_PROMPT.slice(Math.max(0, i - 20), i + 40))}`);
}

if (mismatches === 0 && sysOk) {
  console.log(`  ✓ prompt parity verified`);
  process.exit(0);
}
if (firstSample) {
  console.log(`  ✗ first user-message mismatch: ${firstSample.id}`);
  console.log(`  --- training ---`);
  console.log(firstSample.train);
  console.log(`  --- eval ---`);
  console.log(firstSample.evaL);
}
process.exit(1);
