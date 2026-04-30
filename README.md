# @quaestor/policy

Local-only policy LLM plugin for [quaestor-core](https://github.com/Kabukich0/quaestor-core).
Evaluates mandate redemptions against a natural-language **intent** the user
attached at issuance time, returning an approve/reject verdict + confidence
that quaestor-core's signing pipeline can act on.

The plugin holds **zero keys**. Same trust boundary as the bridge.

## Why local

Intent text is sensitive — it can describe internal merchant rationale, what
an autonomous agent is trying to buy, or arbitrary user-or-agent-provided
text. So:

- Intent **never** leaves the device.
- Intent **never** appears in the mandate JWT.
- Intent **never** appears in logs, traces, or telemetry — there is no
  telemetry. The audit table records `policy.evaluate` entries with score and
  decision only.
- The policy LLM runs in-process inside the daemon via
  [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp). No daemon,
  no socket, no separate process.

## Install

The plugin is opt-in. quaestor-core works fine without it (mandates issued
without an `intent_text` field bypass the LLM entirely; mandates with intent
get a single boot-time warning if the plugin is absent and behave as if
policy is off).

```bash
pnpm add @quaestor/policy            # consumed by quaestor-core
pnpm exec quaestor-policy install    # one-time: download + sha256-verify the GGUF
```

The model is **Qwen 2.5 3B Instruct, Q4_K_M** (~1.9 GB on disk), pinned by
SHA-256, downloaded to `~/.quaestor/models/`. Not bundled in the npm tarball
or the repo. Re-running `install` on a corrupt file re-downloads.

## What it does

```ts
import { evaluateRedemption } from '@quaestor/policy';

const result = await evaluateRedemption({
  intent: 'pay for SaaS hosting and cloud infrastructure only',
  mandate_summary: {
    spend_cap_remaining: '75.00 USDC',
    recipient_policy: 'any',
    expiry_iso: '2026-12-31T23:59:59Z',
    use_counter_remaining: 8,
  },
  redemption: {
    recipient_address: '0x4f6c…',
    recipient_domain: 'render.com',
    amount_usdc: '12.00',
    resource_description: 'render web service starter plan',
  },
});
// result = { verdict: 'approve', confidence: 0.85, reasoning: '…',
//            enforcement: 'approve', latency_ms: 3800, model_id: 'qwen2.5-3b-instruct-q4_k_m' }
```

The `enforcement` field is the policy's recommendation:

| `verdict` | `confidence` | `enforcement` | what core does |
|---|---|---|---|
| `approve` | any | `approve` | proceed to per-protocol sign |
| `reject` | `>= 0.85` | `hard_reject` | return 403 `POLICY_REJECTED` |
| `reject` | `< 0.85`  | `soft_warn` | sign anyway, annotate the receipt |

The 0.85 threshold is locked in `HANDOFF-2.0.md`; tweak the eval set, not the
threshold. A confused model that emits unparseable JSON twice in a row falls
back to `soft_warn` — never `hard_reject` — so a flaky LLM cannot block a
payment whose structured policy has already cleared.

## How to write good intent text

The plugin is biased toward approve-on-broad-positive-intent and
reject-on-explicit-negation. To get reliable enforcement:

- **Be specific about what you DO want.** "infrastructure spend" is
  better than "ops"; "github copilot" is better than "dev tools".
- **Use explicit exclusion language for what you DON'T want.** "no marketing
  tools", "never gambling", "infra-only, never entertainment" — the model
  hard-rejects (≥0.90 confidence) when these match.
- **Mention spend ceilings inline if they're tight.** "agent operations
  under $5 each" gives the model context for novel merchants.
- **Don't overload one mandate.** If you need different rules for different
  vendors, issue separate mandates with separate intents.

Bad: `general spend`. Good: `pay for SaaS hosting only — no advertising`.

Bad: `use the agent's discretion`. Good: `book travel under $200 per leg`.

## Eval

A 60-case eval set lives in `eval/cases.json` (template: `eval/cases.template.json`).
20 obvious-approve, 20 obvious-reject, 20 edge cases. Run it with:

```bash
pnpm eval
```

### Latest results (Qwen 2.5 3B Q4_K_M, 2026-04-29)

| metric | value | target |
|---|---|---|
| total cases | 60 | — |
| accuracy | 91.7% | — |
| false-approve rate | **0%** | ≤5% ✅ |
| false-reject rate | **5%** | ≤10% ✅ |
| obvious_reject correct | 20/20 | — |
| obvious_approve correct | 19/20 | — |
| edge correct | 16/20 | — |
| precision (reject) | 80.0% | — |
| recall (reject) | 100.0% | — |
| F1 | 0.889 | — |
| mean latency | 4665 ms | — |
| p50 latency | 4711 ms | — |
| p95 latency | 5621 ms | ≤5000 ⚠ (12% over) |

Re-run after changing `src/prompt.ts` or the model spec; results land in
`eval/results/latest.json` + a timestamped sibling.

## Tests

```bash
pnpm test                # 28 unit tests, no model required
RUN_MODEL=1 pnpm test    # also run inference fixtures (slow)
```

## Privacy invariants

- The `intent` argument is forwarded to the LLM and discarded. It is **not**
  attached to the returned object beyond what the model itself echoed back
  in `reasoning` (which is text the user already authored — surfacing it back
  to them is fine).
- The model handle stays in this module's closure. There is no public API
  that exposes the underlying KV cache, sampling state, or session.
- A fresh chat session is created per evaluation. No cross-call attention
  leakage.
- The plugin emits **no network traffic** at runtime. Model weights are
  downloaded once at install time; inference is fully local.

## License

MIT. See `LICENSE`.
