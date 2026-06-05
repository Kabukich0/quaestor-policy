"""
Cascade eval on Modal CPU. Mirrors src/cascade/* logic in Python so the 7B
GGUF (which lives on Modal volume) can drive Stage 3 without a local
download.

Usage:
  modal run training/eval_cascade_modal.py
  modal run training/eval_cascade_modal.py --model-path /models/goldseel-7b-v0.2.1_gguf/qwen2.5-7b-instruct.Q4_K_M.gguf

Output: writes JSON to eval/results/cascade-v0.3.0-eval.json on the local
machine.
"""

import json
import re
import time
from datetime import datetime, timezone
import modal


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "build-essential", "cmake", "wget", "curl")
    .pip_install(
        "llama-cpp-python==0.3.2",
        "huggingface-hub",
    )
    .add_local_file(
        "eval/cases-v0.2.0-enriched.json",
        remote_path="/eval-cases.json",
    )
)

app = modal.App("quaestor-cascade-eval", image=image)
volume = modal.Volume.from_name("quaestor-models")


# Byte-identical to training/finetune_modal.py:SYSTEM_PROMPT.
# The model was trained against this prompt; Stage 3 must use it verbatim.
SEMANTIC_SYSTEM_PROMPT = (
    "You are Quaestor's mandate enforcement classifier. You receive "
    "an INTENT (the user-authorized purpose), a MANDATE_SUMMARY "
    "(spend cap, expiry, recipient policy, use counter), and a "
    "REDEMPTION (the proposed payment, including pre-classified "
    "recipient_categories from a vendor registry).\n\n"
    "Your job: decide approve or reject based on three rules:\n"
    "1. MANDATE STATE: if amount > spend_cap_remaining, or "
    "use_counter_remaining = 0, or expiry has passed, or "
    "recipient is explicitly disallowed by recipient_policy "
    "→ reject.\n"
    "2. CATEGORY MATCH: do recipient_categories match what INTENT "
    "authorizes? If yes → approve. If clearly different → reject.\n"
    "3. EXPLICIT CARVE-OUTS: if INTENT contains explicit allowance "
    "for this category → approve. If INTENT contains explicit "
    "prohibition → reject.\n\n"
    "Output VERDICT (approve|reject) followed by REASONING that "
    "cites the specific rule that fired. Examples of valid "
    "reasoning:\n"
    "  - 'Cap exceeded: amount $95 > spend_cap_remaining $80'\n"
    "  - 'Category match: recipient_categories=[ml-inference] "
    "matches intent authorizing AI inference'\n"
    "  - 'Counter exhausted: use_counter_remaining = 0'\n\n"
    "If vendor_known is false, fall back to evaluating "
    "recipient_domain and resource_description directly."
)


# ============================ HARD RULES ============================

def parse_usdc(s):
    if not s: return 0.0
    m = re.match(r'^([\d.]+)', str(s))
    return float(m.group(1)) if m else 0.0


def check_absolute_cap_exceeded(mandate, redemption):
    cap_field = mandate.get('amount_max')
    if not cap_field:
        return None
    cap = parse_usdc(cap_field)
    amount = parse_usdc(redemption.get('amount_usdc'))
    if amount > cap:
        return ('absolute_cap_exceeded',
                f"Per-tx cap exceeded: ${amount:.2f} > amount_max ${cap:.2f}")
    return None


def check_cap_exceeded(mandate, redemption):
    cap = parse_usdc(mandate.get('spend_cap_remaining'))
    amount = parse_usdc(redemption.get('amount_usdc'))
    if amount > cap:
        return ('cap_exceeded',
                f"Cap exceeded: amount ${amount:.2f} > spend_cap_remaining ${cap:.2f}")
    return None


def check_counter_exhausted(mandate, redemption):
    counter = mandate.get('use_counter_remaining')
    if counter is not None and counter <= 0:
        return ('counter_exhausted', f"Counter exhausted: use_counter_remaining = {counter}")
    return None


def check_mandate_expired(mandate, redemption):
    expiry = mandate.get('expiry_iso')
    if not expiry:
        return None
    try:
        # Handle 'Z' suffix
        e = expiry.replace('Z', '+00:00') if expiry.endswith('Z') else expiry
        dt = datetime.fromisoformat(e)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    now = datetime.now(timezone.utc)
    if dt < now:
        return ('mandate_expired', f"Mandate expired: {expiry} < now ({now.isoformat()})")
    return None


def check_recipient_policy_block(mandate, redemption):
    policy = (mandate.get('recipient_policy') or 'any').strip()
    if policy == 'any':
        return None
    domain = (redemption.get('recipient_domain') or '').lower()

    def matches_or_subdomain(d, candidates):
        return any(d == c or d.endswith('.' + c) for c in candidates if c)

    if policy.startswith('block:'):
        blocked = [s.strip().lower() for s in policy[len('block:'):].split(',') if s.strip()]
        if matches_or_subdomain(domain, blocked):
            return ('recipient_policy_explicit_block',
                    f"Recipient policy blocks {domain} (policy={policy})")
        return None
    if policy.startswith('allowlist:'):
        allowed = [s.strip().lower() for s in policy[len('allowlist:'):].split(',') if s.strip()]
        if not matches_or_subdomain(domain, allowed):
            return ('recipient_policy_explicit_block',
                    f"Recipient {domain} not in allowlist [{', '.join(allowed)}]")
        return None
    return None


def check_unknown_vendor_strict(mandate, redemption):
    if mandate.get('strict_unknown_policy') == 'reject' and redemption.get('vendor_known') is False:
        return ('unknown_vendor_strict_policy',
                "Vendor unknown (not in registry) and strict_unknown_policy=reject")
    return None


PHISHING_PATTERNS = [
    re.compile(r'^(login|verify|secure|account|update|claim|prize|urgent)-[\w-]+\.(net|org|info|biz|xyz|tk|shop|click|fun|ml|ga|cf)$', re.I),
    re.compile(r'^[\w-]+-(login|verify|secure|payment|update|credentials|portal)-?[\w-]*\.[\w-]+$', re.I),
    re.compile(r'^(win|free|claim|prize)-[\w-]+\.(click|fun|tk|ml|ga|cf|xyz)$', re.I),
    re.compile(r'^[\w-]+\.(tk|ml|ga|cf)$', re.I),
]


def check_phishing_domain(mandate, redemption):
    domain = (redemption.get('recipient_domain') or '').lower()
    if not domain:
        return None
    for p in PHISHING_PATTERNS:
        if p.match(domain):
            return ('phishing_domain_pattern', f"Domain {domain} matches phishing pattern")
    return None


NAMED_ONLY_RE = re.compile(r'\b([\w-]+(?:\.[\w-]+)+)\s+only\b', re.I)
EXCLUSIVELY_RE = re.compile(r'\bexclusively\s+([\w-]+(?:\.[\w-]+)+)', re.I)


def check_named_vendor_whitelist_miss(mandate, intent, redemption):
    domain = (redemption.get('recipient_domain') or '').lower()
    if not domain:
        return None
    only_m = NAMED_ONLY_RE.search(intent)
    if only_m:
        named = only_m.group(1).lower()
        if not (domain == named or domain.endswith('.' + named) or named.endswith('.' + domain)):
            return ('named_vendor_whitelist_miss',
                    f'Intent specifies "{named} only" but redemption is to {domain}')
    excl_m = EXCLUSIVELY_RE.search(intent)
    if excl_m:
        named = excl_m.group(1).lower()
        if not (domain == named or domain.endswith('.' + named) or named.endswith('.' + domain)):
            return ('named_vendor_whitelist_miss',
                    f'Intent specifies "exclusively {named}" but redemption is to {domain}')
    return None


def run_hard_rules(mandate, intent, redemption):
    """Returns (rule_id, reason) or None."""
    for fn in (
        check_absolute_cap_exceeded,
        check_cap_exceeded,
        check_counter_exhausted,
        check_mandate_expired,
        check_recipient_policy_block,
        check_unknown_vendor_strict,
        check_phishing_domain,
    ):
        result = fn(mandate, redemption)
        if result is not None:
            return result
    nv = check_named_vendor_whitelist_miss(mandate, intent, redemption)
    if nv is not None:
        return nv
    return None


# ============================ PROMPT FORMAT ============================

def format_user_msg(mandate, intent, enriched_redemption):
    view = {
        "recipient_domain": enriched_redemption.get("recipient_domain"),
        "recipient_name": enriched_redemption.get("recipient_name"),
        "recipient_categories": enriched_redemption.get("recipient_categories", []),
        "vendor_known": enriched_redemption.get("vendor_known", False),
        "amount_usdc": enriched_redemption.get("amount_usdc"),
        "resource_description": enriched_redemption.get("resource_description"),
    }
    return (
        f"INTENT: {intent}\n"
        f"MANDATE_SUMMARY: {json.dumps(mandate, separators=(',', ':'), ensure_ascii=False)}\n"
        f"REDEMPTION: {json.dumps(view, separators=(',', ':'), ensure_ascii=False)}"
    )


def parse_verdict(text):
    verdict, reasoning = None, None
    for line in text.strip().split("\n"):
        line = line.strip()
        if line.upper().startswith("VERDICT"):
            v = line.split(":", 1)[-1].strip().lower()
            if "approve" in v:
                verdict = "approve"
            elif "reject" in v:
                verdict = "reject"
        elif line.upper().startswith("REASONING"):
            reasoning = line.split(":", 1)[-1].strip()
    return verdict, reasoning


# ============================ CASCADE ============================

@app.function(
    cpu=4,
    memory=16384,
    timeout=3600,
    volumes={"/models": volume},
)
def run_cascade_eval(model_path: str = "/models/goldseel-7b-v0.2.1_gguf/qwen2.5-7b-instruct.Q4_K_M.gguf"):
    from llama_cpp import Llama

    print(f"Loading {model_path}")
    llm = Llama(model_path=model_path, n_ctx=2048, n_threads=4, verbose=False)
    print("Model loaded")

    with open("/eval-cases.json") as f:
        cases = json.load(f)
    print(f"Running cascade eval on {len(cases)} cases")

    results = []
    for i, case in enumerate(cases):
        mandate = case["mandate_summary"]
        intent = case["intent"]
        # Cases come pre-enriched with recipient_categories/name/vendor_known.
        redemption = case["redemption"]

        stages_run = ["vendor_lookup", "hard_rules"]
        latency = {"vendor_lookup": 0}

        t2 = time.time()
        rule_result = run_hard_rules(mandate, intent, redemption)
        latency["hard_rules"] = int((time.time() - t2) * 1000)

        if rule_result is not None:
            rule_id, reason = rule_result
            results.append({
                "id": case["id"],
                "category": case["category"],
                "expected": case["expected_verdict"],
                "actual": "reject",
                "match": case["expected_verdict"] == "reject",
                "decided_at": "hard_rules",
                "rule_fired": rule_id,
                "reasoning": reason,
                "stages_run": stages_run,
                "latency_ms_per_stage": latency,
                "model_called": False,
                "total_latency_ms": sum(latency.values()),
            })
        else:
            stages_run.append("semantic_classifier")
            t3 = time.time()
            messages = [
                {"role": "system", "content": SEMANTIC_SYSTEM_PROMPT},
                {"role": "user", "content": format_user_msg(mandate, intent, redemption)},
            ]
            response = llm.create_chat_completion(messages=messages, max_tokens=200, temperature=0.0)
            latency["semantic_classifier"] = int((time.time() - t3) * 1000)
            output = response["choices"][0]["message"]["content"]
            verdict, reasoning = parse_verdict(output)
            actual = verdict if verdict else "reject"
            results.append({
                "id": case["id"],
                "category": case["category"],
                "expected": case["expected_verdict"],
                "actual": actual,
                "match": case["expected_verdict"] == actual,
                "decided_at": "semantic_classifier",
                "rule_fired": None,
                "reasoning": reasoning,
                "stages_run": stages_run,
                "latency_ms_per_stage": latency,
                "model_called": True,
                "total_latency_ms": sum(latency.values()),
                "raw_output": output,
            })

        if (i + 1) % 10 == 0:
            correct = sum(1 for r in results if r["match"])
            decided_hr = sum(1 for r in results if r["decided_at"] == "hard_rules")
            print(f"  {i+1}/{len(cases)} — accuracy {correct}/{i+1} | hard_rules decided {decided_hr}")

    # ============================ Summary ============================
    total = len(results)
    correct = sum(1 for r in results if r["match"])
    fa = sum(1 for r in results if r["expected"] == "reject" and r["actual"] == "approve")
    fr = sum(1 for r in results if r["expected"] == "approve" and r["actual"] == "reject")
    total_reject = sum(1 for r in results if r["expected"] == "reject")
    total_approve = sum(1 for r in results if r["expected"] == "approve")

    by_cat = {}
    for r in results:
        b = by_cat.setdefault(r["category"], {"total": 0, "correct": 0})
        b["total"] += 1
        if r["match"]:
            b["correct"] += 1

    decided_hr = [r for r in results if r["decided_at"] == "hard_rules"]
    decided_sc = [r for r in results if r["decided_at"] == "semantic_classifier"]

    def percentile(vals, p):
        if not vals: return 0
        s = sorted(vals)
        return s[int(len(s) * p)]

    hr_lat = [r["latency_ms_per_stage"].get("hard_rules", 0) for r in results]
    sc_lat = [r["latency_ms_per_stage"].get("semantic_classifier", 0) for r in decided_sc]
    total_lat = [r["total_latency_ms"] for r in results]

    summary = {
        "total": total,
        "correct": correct,
        "accuracy": correct / total if total else 0,
        "false_approve": fa,
        "false_approve_rate": fa / total_reject if total_reject else 0,
        "false_reject": fr,
        "false_reject_rate": fr / total_approve if total_approve else 0,
        "by_category": by_cat,
        "stage_decisions": {
            "hard_rules": {
                "count": len(decided_hr),
                "correct": sum(1 for r in decided_hr if r["match"]),
                "accuracy": (sum(1 for r in decided_hr if r["match"]) / len(decided_hr)) if decided_hr else None,
            },
            "semantic_classifier": {
                "count": len(decided_sc),
                "correct": sum(1 for r in decided_sc if r["match"]),
                "accuracy": (sum(1 for r in decided_sc if r["match"]) / len(decided_sc)) if decided_sc else None,
            },
        },
        "rule_fire_counts": {},
        "latency_ms": {
            "hard_rules_p50": percentile(hr_lat, 0.5),
            "hard_rules_p95": percentile(hr_lat, 0.95),
            "semantic_p50": percentile(sc_lat, 0.5),
            "semantic_p95": percentile(sc_lat, 0.95),
            "total_p50": percentile(total_lat, 0.5),
            "total_p95": percentile(total_lat, 0.95),
        },
        "model_path": model_path,
    }
    for r in decided_hr:
        rid = r["rule_fired"] or "unknown"
        summary["rule_fire_counts"][rid] = summary["rule_fire_counts"].get(rid, 0) + 1

    print("\n=== Summary ===")
    print(json.dumps(summary, indent=2))

    return {"summary": summary, "results": results}


@app.local_entrypoint()
def main(model_path: str = "", out: str = "eval/results/cascade-v0.3.0-eval.json"):
    if model_path:
        result = run_cascade_eval.remote(model_path)
    else:
        result = run_cascade_eval.remote()

    import os
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(result, f, indent=2)
    print(f"\nResults saved to {out}")
