/**
 * Phase 2.0 demo — four hand-picked cases that visibly exercise the policy
 * engine's full decision surface.
 *
 *   A. clean approve  — intent matches household-name vendor.
 *   B. clean hard reject — explicit negation, recipient in excluded category.
 *   C. soft warn — ambiguous recipient, model uncertain (<0.85).
 *   D. amount-policy interaction — small spend to a novel merchant; structured
 *      policy lets it through, model adds a soft note.
 *
 * Each case prints the verdict + confidence + reasoning + latency_ms with a
 * short banner. This is the artifact recorded for the Phase 2.0 video.
 */
import { evaluateRedemption, preload } from '../src/evaluate.js';
import type { EvaluateInput } from '../src/evaluate.js';

interface Case {
  label: string;
  description: string;
  input: EvaluateInput;
  expected_enforcement: 'approve' | 'soft_warn' | 'hard_reject';
}

const CASES: Case[] = [
  {
    label: 'A',
    description: 'clean approve — "SaaS only" + render.com',
    expected_enforcement: 'approve',
    input: {
      intent: 'pay only for SaaS hosting and dev infrastructure',
      mandate_summary: {
        spend_cap_remaining: '50.00 USDC',
        recipient_policy: 'any',
        expiry_iso: '2026-12-31T23:59:59Z',
        use_counter_remaining: 8,
      },
      redemption: {
        recipient_address: '0x4f6c2a7b9d3e5f1a2b3c4d5e6f7a8b9c0d1e2f3a',
        recipient_domain: 'render.com',
        amount_usdc: '12.00',
        resource_description: 'render web service starter plan',
      },
    },
  },
  {
    label: 'B',
    description: 'clean hard reject — "no marketing tools" + mailchimp.com',
    expected_enforcement: 'hard_reject',
    input: {
      intent: 'pay for engineering infrastructure only — no marketing tools',
      mandate_summary: {
        spend_cap_remaining: '100.00 USDC',
        recipient_policy: 'any',
        expiry_iso: '2026-12-31T23:59:59Z',
        use_counter_remaining: 5,
      },
      redemption: {
        recipient_address: '0x6767676767676767676767676767676767676767',
        recipient_domain: 'mailchimp.com',
        amount_usdc: '29.00',
        resource_description: 'mailchimp essentials plan',
      },
    },
  },
  {
    label: 'C',
    description: 'soft warn — "infra spend" + ambiguous novel domain (<0.85)',
    expected_enforcement: 'soft_warn',
    input: {
      intent: 'infrastructure spend',
      mandate_summary: {
        spend_cap_remaining: '75.00 USDC',
        recipient_policy: 'any',
        expiry_iso: '2026-12-31T23:59:59Z',
        use_counter_remaining: 4,
      },
      redemption: {
        recipient_address: '0x3030303030303030303030303030303030303030',
        recipient_domain: 'unknown-cdn-vendor.tk',
        amount_usdc: '30.00',
        resource_description: 'cdn service from a novel provider',
      },
    },
  },
  {
    label: 'D',
    description: 'amount-policy interaction — "under $50" + $47 to novel merchant',
    expected_enforcement: 'approve',
    input: {
      intent: 'agent operations under $50 per call',
      mandate_summary: {
        spend_cap_remaining: '50.00 USDC',
        recipient_policy: 'any',
        expiry_iso: '2026-08-31T00:00:00Z',
        use_counter_remaining: 2,
      },
      redemption: {
        recipient_address: '0x5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b',
        recipient_domain: 'tier4-saas.dev',
        amount_usdc: '47.00',
        resource_description: 'novel saas, claims to provide log aggregation',
      },
    },
  },
];

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function colorForEnforcement(enf: string): string {
  if (enf === 'approve') return COLOR.green;
  if (enf === 'soft_warn') return COLOR.yellow;
  return COLOR.red;
}

async function main() {
  process.stdout.write(`${COLOR.bold}quaestor-policy — Phase 2.0 demo${COLOR.reset}\n`);
  process.stdout.write(`${COLOR.dim}local Qwen 2.5 3B Q4_K_M, ~2GB, in-process via node-llama-cpp${COLOR.reset}\n\n`);
  process.stdout.write(`${COLOR.dim}preloading model (first call ~5–10s on M-series, ~30s cold)…${COLOR.reset}\n`);
  await preload();

  for (const c of CASES) {
    process.stdout.write(
      `\n${COLOR.bold}${COLOR.cyan}━━━ Case ${c.label}: ${c.description} ━━━${COLOR.reset}\n`,
    );
    process.stdout.write(`  intent:     ${c.input.intent}\n`);
    process.stdout.write(
      `  redemption: ${c.input.redemption.amount_usdc} USDC → ${
        c.input.redemption.recipient_domain ?? c.input.redemption.recipient_address
      }\n`,
    );
    process.stdout.write(`  resource:   ${c.input.redemption.resource_description ?? '(unspecified)'}\n`);
    process.stdout.write(`  expected:   ${c.expected_enforcement}\n`);
    const r = await evaluateRedemption(c.input);
    const colour = colorForEnforcement(r.enforcement);
    const ok = r.enforcement === c.expected_enforcement ? `${COLOR.green}✓${COLOR.reset}` : `${COLOR.yellow}≠${COLOR.reset}`;
    process.stdout.write(
      `  ${COLOR.bold}verdict:${COLOR.reset}    ${colour}${r.verdict}${COLOR.reset}` +
        ` (confidence ${r.confidence.toFixed(2)})\n`,
    );
    process.stdout.write(
      `  ${COLOR.bold}enforce:${COLOR.reset}    ${colour}${r.enforcement}${COLOR.reset}  ${ok}\n`,
    );
    process.stdout.write(`  ${COLOR.bold}reason:${COLOR.reset}     ${r.reasoning}\n`);
    process.stdout.write(`  ${COLOR.dim}${r.latency_ms} ms · ${r.model_id}${COLOR.reset}\n`);
  }

  process.stdout.write('\n');
}

main().catch((e) => {
  process.stderr.write(`demo failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
