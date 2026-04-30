/**
 * Eval harness — drives the full case set through evaluateRedemption and
 * computes acceptance metrics.
 *
 * Targets (from HANDOFF-2.0.md):
 *   - false-approve rate <= 5% on obvious_reject set
 *   - false-reject rate <= 10% on obvious_approve set
 *   - p95 latency      <= 5s
 *
 * Output:
 *   - prints a summary table to stdout
 *   - writes eval/results/<timestamp>.json
 *   - writes eval/results/latest.json (for README auto-section)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRedemption } from '../src/evaluate.js';

interface Case {
  id: string;
  category: 'obvious_approve' | 'obvious_reject' | 'edge';
  intent: string;
  mandate_summary: {
    spend_cap_remaining: string;
    recipient_policy: string;
    expiry_iso: string;
    use_counter_remaining: number;
  };
  redemption: {
    recipient_address: string;
    recipient_domain?: string;
    amount_usdc: string;
    resource_description?: string;
  };
  expected_verdict: 'approve' | 'reject' | '';
  expected_reasoning: string;
}

interface CaseResult {
  id: string;
  category: Case['category'];
  expected: 'approve' | 'reject';
  actual: 'approve' | 'reject';
  confidence: number;
  enforcement: string;
  latency_ms: number;
  match: boolean;
  reasoning: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const casesPath = path.join(here, 'cases.json');
  let cases: Case[];
  try {
    cases = JSON.parse(readFileSync(casesPath, 'utf8'));
  } catch {
    process.stderr.write(
      `eval/cases.json not found. Copy eval/cases.template.json to eval/cases.json and fill in expected_verdict for each case.\n`,
    );
    process.exit(2);
    return;
  }

  const unlabeled = cases.filter((c) => c.expected_verdict !== 'approve' && c.expected_verdict !== 'reject');
  if (unlabeled.length > 0) {
    process.stderr.write(`eval blocked: ${unlabeled.length} cases unlabeled (first: ${unlabeled[0]?.id})\n`);
    process.exit(2);
    return;
  }

  process.stderr.write(`[eval] ${cases.length} cases — loading model (first call may take 30s)\n`);

  const results: CaseResult[] = [];
  let i = 0;
  for (const c of cases) {
    i++;
    const out = await evaluateRedemption({
      intent: c.intent,
      mandate_summary: c.mandate_summary,
      redemption: c.redemption,
    });
    const expected = c.expected_verdict as 'approve' | 'reject';
    const actual = out.verdict;
    const match = expected === actual;
    results.push({
      id: c.id,
      category: c.category,
      expected,
      actual,
      confidence: out.confidence,
      enforcement: out.enforcement,
      latency_ms: out.latency_ms,
      match,
      reasoning: out.reasoning,
    });
    process.stderr.write(
      `[eval] ${i}/${cases.length} ${c.id} (${c.category}): expected=${expected} actual=${actual} conf=${out.confidence.toFixed(2)} ${out.latency_ms}ms ${match ? 'OK' : 'MISMATCH'}\n`,
    );
  }

  const summary = summarise(results);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(here, 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${ts}.json`), JSON.stringify({ summary, results }, null, 2));
  writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify({ summary, results }, null, 2));

  printSummary(summary);

  const passed =
    summary.false_approve_rate <= 0.05 &&
    summary.false_reject_rate <= 0.1 &&
    summary.p95_latency_ms <= 5000;
  process.exit(passed ? 0 : 1);
}

interface Summary {
  total: number;
  matches: number;
  accuracy: number;
  obvious_approve_total: number;
  obvious_approve_correct: number;
  obvious_reject_total: number;
  obvious_reject_correct: number;
  edge_total: number;
  edge_correct: number;
  false_approve_rate: number;
  false_reject_rate: number;
  precision: number;
  recall: number;
  f1: number;
  mean_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  generated_at_iso: string;
}

function summarise(results: CaseResult[]): Summary {
  const total = results.length;
  const matches = results.filter((r) => r.match).length;
  const oa = results.filter((r) => r.category === 'obvious_approve');
  const or = results.filter((r) => r.category === 'obvious_reject');
  const edge = results.filter((r) => r.category === 'edge');
  const oaCorrect = oa.filter((r) => r.match).length;
  const orCorrect = or.filter((r) => r.match).length;
  const edgeCorrect = edge.filter((r) => r.match).length;

  // false approve = labeled reject, model said approve, on obvious_reject set
  const falseApprove = or.filter((r) => r.expected === 'reject' && r.actual === 'approve').length;
  // false reject = labeled approve, model said reject, on obvious_approve set
  const falseReject = oa.filter((r) => r.expected === 'approve' && r.actual === 'reject').length;

  // Precision/recall on the binary "reject" decision (treating reject as positive class).
  const truePos = results.filter((r) => r.expected === 'reject' && r.actual === 'reject').length;
  const falsePos = results.filter((r) => r.expected === 'approve' && r.actual === 'reject').length;
  const falseNeg = results.filter((r) => r.expected === 'reject' && r.actual === 'approve').length;
  const precision = truePos / Math.max(1, truePos + falsePos);
  const recall = truePos / Math.max(1, truePos + falseNeg);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);

  const latencies = [...results.map((r) => r.latency_ms)].sort((a, b) => a - b);
  const mean = latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  return {
    total,
    matches,
    accuracy: matches / Math.max(1, total),
    obvious_approve_total: oa.length,
    obvious_approve_correct: oaCorrect,
    obvious_reject_total: or.length,
    obvious_reject_correct: orCorrect,
    edge_total: edge.length,
    edge_correct: edgeCorrect,
    false_approve_rate: falseApprove / Math.max(1, or.length),
    false_reject_rate: falseReject / Math.max(1, oa.length),
    precision,
    recall,
    f1,
    mean_latency_ms: Math.round(mean),
    p50_latency_ms: p50,
    p95_latency_ms: p95,
    generated_at_iso: new Date().toISOString(),
  };
}

function printSummary(s: Summary) {
  process.stdout.write('\n');
  process.stdout.write('=== eval summary ===\n');
  process.stdout.write(`total:                  ${s.total}\n`);
  process.stdout.write(`accuracy:               ${(s.accuracy * 100).toFixed(1)}%\n`);
  process.stdout.write(`obvious_approve:        ${s.obvious_approve_correct}/${s.obvious_approve_total}\n`);
  process.stdout.write(`obvious_reject:         ${s.obvious_reject_correct}/${s.obvious_reject_total}\n`);
  process.stdout.write(`edge:                   ${s.edge_correct}/${s.edge_total}\n`);
  process.stdout.write(`false_approve_rate:     ${(s.false_approve_rate * 100).toFixed(1)}% (target <= 5%)\n`);
  process.stdout.write(`false_reject_rate:      ${(s.false_reject_rate * 100).toFixed(1)}% (target <= 10%)\n`);
  process.stdout.write(`precision (reject):     ${(s.precision * 100).toFixed(1)}%\n`);
  process.stdout.write(`recall (reject):        ${(s.recall * 100).toFixed(1)}%\n`);
  process.stdout.write(`f1:                     ${s.f1.toFixed(3)}\n`);
  process.stdout.write(`mean latency:           ${s.mean_latency_ms} ms\n`);
  process.stdout.write(`p50 latency:            ${s.p50_latency_ms} ms\n`);
  process.stdout.write(`p95 latency:            ${s.p95_latency_ms} ms (target <= 5000)\n`);
  process.stdout.write('====================\n');
}

main().catch((e) => {
  process.stderr.write(`eval crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
