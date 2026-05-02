# Quaestor Goldseel — Training Data v0.1.1 / Eval v0.2.0

## State after this commit

### Training set
- **Final dataset**: `eval/training-cases-v0.1.1.jsonl` — **1443 cases**
- **Approves**: 970 verdicts (958 base approve cases + 12 subdomain_pair_approve cases from reject batches)
- **Rejects**: 473 verdicts (485 reject cases minus 12 subdomain_pair_approve)
- **Reject rate**: 32.8% — intentionally over production rate to correct for prior approve-only bias
- **Generation**: natural prose via Claude Sonnet 4.6, no template scripts
- **Top trigram frequency**: 0.9% across 336 batch-004-010 cases
- **Train/eval domain contamination**: 0 cases

### Held-out eval set
- **Canonical eval**: `eval/cases.json` — **160 cases** (was 60)
  - obvious_approve: 75 (50%)
  - obvious_reject: 45 (30%)
  - edge: 40 (20%)
- **Eval expansion**: 100 new cases (90 main + 10 corrective edge batch)
- **0 contamination** with `eval/training-cases-v0.1.1.jsonl`
- **0 label errors** across 40 spot-checked cases

## Reject archetype coverage in eval (obvious_reject + edge-reject)

| Archetype | Min cases in eval |
|---|---|
| explicit_prohibition | 8 |
| intent_mismatch | 8 |
| personal_consumer | 6 |
| financial_speculation | 5 |
| scam_fraud | 2 |
| recipient_constraint | 8 |

Edge-reject mandate-state failure modes (new in v0.2.0):
- overspend (amount > cap)
- depleted use counter (use_counter_remaining = 0)
- expired mandate (expiry_iso in past)
- zero remaining balance (spend_cap_remaining = 0.00)
- named-vendor whitelist miss (right category, wrong vendor)

## Eval subdomain pairs (4 pairs = 8 cases, all fresh vs training data)

| Parent (reject) | Authorized subdomain (approve) | Signal |
|---|---|---|
| okta.com | developer.okta.com | dev portal vs consumer domain |
| snowflake.com | app.snowflake.com | marketing site vs billing portal |
| zoom.us | api.zoom.us | consumer portal vs API endpoint |
| terraform.io | app.terraform.io | docs site vs app billing portal |

None overlap with the 8 training-data subdomain pairs — validates whether
fine-tune learned subdomain semantics generally vs. memorized training pairs.

## Training subdomain pairs (8 parent/child verdict pairs)

| Parent (reject) | Authorized subdomain (approve) | Mandate theme |
|---|---|---|
| azure.microsoft.com | — (original pair) | cloud infra |
| npmjs.com | registry.npmjs.com | package registry |
| docker.com | hub.docker.com | container registry |
| atlassian.com | confluence.atlassian.com | team wiki |
| elastic.co | cloud.elastic.co | managed Elasticsearch |
| auth0.com | manage.auth0.com | identity management |
| hashicorp.com | releases.hashicorp.com | IaC binaries |
| splunk.com | api.splunk.com | SIEM / log analytics |

## File layout

```
eval/
  cases.json                               ← canonical eval (160 cases, held out)
  training-cases-v0.1.1.jsonl              ← canonical training set (1443 cases)
  training-cases-v0.1.0-aligned.jsonl      ← prior approve-only dataset
  archive/
    cases-expansion-v1-source.json         ← eval expansion batch 1-3 (90 cases)
    cases-expansion-v1-batch4-source.json  ← corrective edge batch (10 cases)
  training-batches-v0.1.1/
    reject-batch-001.json .. reject-batch-010.json   ← reject source batches
    approve-batches/                                  ← approve source batches (copy of v0.1.0/)
  training-batches-v0.1.0/           ← original approve batch archive
training/
  finetune_modal.py
  transform_schema.py
```

## Schema note

The training dataset contains two schema variants from different generation phases:

**Approve cases** (from v0.1.0-aligned): `_training_cluster`, `_training_currency`, `_training_label`

**Reject cases** (batches 001-010): `_training_archetype`

Both share the canonical fields: `id`, `category`, `intent`, `mandate_summary`, `redemption`, `expected_verdict`, `expected_reasoning`. The fine-tune pipeline should use only canonical fields; metadata fields can be stripped by `transform_schema.py` before training.

The **eval** (`cases.json`) uses canonical fields only — no metadata fields.

## Known pre-existing non-issues

- `apple.com` appears in both batch-001 (personal_consumer, $999 MacBook accessories) and batch-002 (recipient_constraint, $99.99 iPhone case against an Apple-developer-only mandate). Different scenarios, valid variation — keep both.
- `""` (empty domain) appears in both eval `reject-010` and training `r001-f008`. Both represent the same real-world signal (no-domain = wallet transfer = reject) with independent phrasing — not contamination.

## Next steps

1. **Schema normalization**: run `transform_schema.py` to strip metadata fields and produce a clean JSONL for Modal
2. **Fine-tune**: LoRA on Qwen 2.5 3B base via Modal (`training/finetune_modal.py`)
3. **Eval**: run against `eval/cases.json` (160 cases), target >90% accuracy on reject archetypes
4. **Ship**: `quaestor-goldseel-3b-v0.1.0`
