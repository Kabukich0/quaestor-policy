# Quaestor Goldseel — Training Data v0.1.1

## State after this commit

- **Final dataset**: `eval/training-cases-v0.1.1.jsonl` — **1443 cases**
- **Approves**: 970 verdicts (958 base approve cases + 12 subdomain_pair_approve cases from reject batches)
- **Rejects**: 473 verdicts (485 reject cases minus 12 subdomain_pair_approve)
- **Reject rate**: 32.8% — intentionally over production rate to correct for prior approve-only bias
- **Generation**: natural prose via Claude Sonnet 4.6, no template scripts
- **Top trigram frequency**: 0.9% across 336 batch-004-010 cases
- **Train/eval domain contamination**: 0 cases

## Archetype distribution (reject batches)

| Archetype | Count |
|---|---|
| explicit_prohibition | 101 |
| intent_mismatch | 131 |
| personal_consumer | 81 |
| financial_speculation | 50 |
| recipient_constraint | 80 |
| scam_fraud | 30 |
| subdomain_pair_approve | 12 |
| **Total** | **485** |

## Subdomain pairs (8 parent/child verdict pairs)

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
  training-cases-v0.1.1.jsonl       ← canonical dataset (this commit)
  training-cases-v0.1.0-aligned.jsonl  ← prior approve-only dataset
  training-batches-v0.1.1/
    reject-batch-001.json .. reject-batch-010.json   ← reject source batches
    approve-batches/                                  ← approve source batches (copy of v0.1.0/)
  training-batches-v0.1.0/           ← original approve batch archive
  cases.json                         ← eval ground truth (60 cases, held out)
training/
  finetune_modal.py
  transform_schema.py
```

## Schema note

The dataset contains two schema variants from different generation phases:

**Approve cases** (from v0.1.0-aligned): `_training_cluster`, `_training_currency`, `_training_label`

**Reject cases** (batches 001-010): `_training_archetype`

Both share the canonical fields: `id`, `category`, `intent`, `mandate_summary`, `redemption`, `expected_verdict`, `expected_reasoning`. The fine-tune pipeline should use only canonical fields; metadata fields can be stripped by `transform_schema.py` before training.

## Known pre-existing non-issues

- `apple.com` appears in both batch-001 (personal_consumer, $999 MacBook accessories) and batch-002 (recipient_constraint, $99.99 iPhone case against an Apple-developer-only mandate). Different scenarios, valid variation — keep both.
- `""` (empty domain) appears in both eval `reject-010` and training `r001-f008`. Both represent the same real-world signal (no-domain = wallet transfer = reject) with independent phrasing — not contamination.

## Next steps

1. **Eval expansion**: grow `eval/cases.json` from 60 → 150 cases (NOT YET DONE)
2. **Schema normalization**: run `transform_schema.py` to strip metadata fields and produce a clean JSONL for Modal
3. **Fine-tune**: LoRA on Qwen 2.5 3B base via Modal (`training/finetune_modal.py`)
4. **Eval**: run against expanded held-out set, target >90% accuracy on reject archetypes
5. **Ship**: `quaestor-goldseel-3b-v0.1.0`
