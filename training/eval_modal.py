"""
Run the 160-case held-out eval against a Goldseel GGUF on Modal CPU.
Avoids local 7B GGUF download — model lives on the volume.

Usage:
  modal run training/eval_modal.py
  modal run training/eval_modal.py --model-path /models/goldseel-7b-v0.2.1_gguf/qwen2.5-7b-instruct.Q4_K_M.gguf

Output: writes JSON to eval/results/goldseel-<tag>-eval.json on the user's
machine (returned via Modal serialisation).
"""

import json
import time
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

app = modal.App("quaestor-goldseel-eval", image=image)
volume = modal.Volume.from_name("quaestor-models")


# Must be byte-identical to training/finetune_modal.py:SYSTEM_PROMPT.
SYSTEM_PROMPT = (
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


def format_user_msg(case):
    """Mirror training/finetune_modal.py:format_case() user-side bytes exactly."""
    redemption = case.get("redemption", {})
    redemption_view = {
        "recipient_domain": redemption.get("recipient_domain"),
        "recipient_name": redemption.get("recipient_name"),
        "recipient_categories": redemption.get("recipient_categories", []),
        "vendor_known": redemption.get("vendor_known", False),
        "amount_usdc": redemption.get("amount_usdc"),
        "resource_description": redemption.get("resource_description"),
    }
    return (
        f"INTENT: {case['intent']}\n"
        f"MANDATE_SUMMARY: {json.dumps(case['mandate_summary'], separators=(',', ':'), ensure_ascii=False)}\n"
        f"REDEMPTION: {json.dumps(redemption_view, separators=(',', ':'), ensure_ascii=False)}"
    )


def parse_verdict(text: str):
    verdict = None
    reasoning = None
    for raw in text.strip().split("\n"):
        line = raw.strip()
        if line.upper().startswith("VERDICT"):
            v = line.split(":", 1)[-1].strip().lower()
            if "approve" in v:
                verdict = "approve"
            elif "reject" in v:
                verdict = "reject"
        elif line.upper().startswith("REASONING"):
            reasoning = line.split(":", 1)[-1].strip()
    return verdict, reasoning


@app.function(
    cpu=4,
    memory=16384,
    timeout=3600,
    volumes={"/models": volume},
)
def run_eval(model_path: str = "/models/goldseel-7b-v0.2.2_gguf/qwen2.5-7b-instruct.Q4_K_M.gguf"):
    from llama_cpp import Llama

    print(f"Loading {model_path}")
    llm = Llama(
        model_path=model_path,
        n_ctx=2048,
        n_threads=4,
        verbose=False,
    )
    print("Model loaded")

    with open("/eval-cases.json") as f:
        cases = json.load(f)
    print(f"Running eval on {len(cases)} cases")

    results = []
    for i, case in enumerate(cases):
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": format_user_msg(case)},
        ]

        t0 = time.time()
        response = llm.create_chat_completion(
            messages=messages,
            max_tokens=200,
            temperature=0.0,
        )
        latency_ms = int((time.time() - t0) * 1000)

        output = response["choices"][0]["message"]["content"]
        predicted, reasoning = parse_verdict(output)

        match = predicted == case["expected_verdict"]
        results.append({
            "id": case["id"],
            "category": case["category"],
            "expected": case["expected_verdict"],
            "actual": predicted,
            "match": match,
            "reasoning": reasoning,
            "raw_output": output,
            "latency_ms": latency_ms,
        })

        if (i + 1) % 10 == 0:
            correct = sum(1 for r in results if r["match"])
            print(f"  {i+1}/{len(cases)} — accuracy {correct}/{i+1}")

    total = len(results)
    correct = sum(1 for r in results if r["match"])
    false_approve = sum(1 for r in results if r["expected"] == "reject" and r["actual"] == "approve")
    false_reject = sum(1 for r in results if r["expected"] == "approve" and r["actual"] == "reject")
    total_reject = sum(1 for r in results if r["expected"] == "reject")
    total_approve = sum(1 for r in results if r["expected"] == "approve")

    by_cat = {}
    for r in results:
        bucket = by_cat.setdefault(r["category"], {"total": 0, "correct": 0})
        bucket["total"] += 1
        if r["match"]:
            bucket["correct"] += 1

    latencies = sorted(r["latency_ms"] for r in results)
    p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0
    mean = sum(latencies) / max(1, len(latencies))

    summary = {
        "total": total,
        "correct": correct,
        "accuracy": correct / total if total else 0,
        "false_approve": false_approve,
        "false_approve_rate": false_approve / total_reject if total_reject else 0,
        "false_reject": false_reject,
        "false_reject_rate": false_reject / total_approve if total_approve else 0,
        "by_category": by_cat,
        "p95_latency_ms": p95,
        "mean_latency_ms": int(mean),
        "model_path": model_path,
    }

    print("\n=== Summary ===")
    print(json.dumps(summary, indent=2))

    return {"summary": summary, "results": results}


@app.local_entrypoint()
def main(model_path: str = "", out: str = "eval/results/goldseel-7b-v0.2.2-eval.json"):
    if model_path:
        result = run_eval.remote(model_path)
    else:
        result = run_eval.remote()

    import os
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(result, f, indent=2)
    print(f"\nResults saved to {out}")
