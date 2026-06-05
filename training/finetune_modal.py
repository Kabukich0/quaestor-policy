import modal
import json


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "git", "build-essential", "cmake", "wget",
        # pre-installed so unsloth's package check finds them and skips input() prompt
        "curl", "libcurl4-openssl-dev", "libssl-dev",
    )
    .env({"LD_LIBRARY_PATH": "/usr/lib64-nvidia:/usr/local/cuda/lib64"})
    .pip_install(
        "torch==2.7.0",
        "torchvision==0.22.0",
        "bitsandbytes==0.49.2",
        "sentencepiece",
        "protobuf",
    )
    .pip_install(
        "unsloth_zoo==2026.4.9",
        "unsloth==2026.4.8",
    )
    .add_local_file(
        "eval/training-cases-v0.2.2-enriched.jsonl",
        "/training-data.jsonl",
    )
)

app = modal.App("quaestor-goldseel-finetune", image=image)
volume = modal.Volume.from_name("quaestor-models", create_if_missing=True)


@app.function(
    gpu="H100",
    timeout=3600 * 2,
    volumes={"/models": volume},
)
def finetune():
    from unsloth import FastLanguageModel
    from trl import SFTTrainer, SFTConfig
    from datasets import Dataset
    import torch

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name="Qwen/Qwen2.5-7B-Instruct",
        max_seq_length=2048,
        dtype=None,
        load_in_4bit=True,
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=42,
    )

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

    def format_case(case):
        mandate = case.get("mandate_summary", {})
        redemption = case.get("redemption", {})
        # The redemption arrives already enriched (Stage 2 schema):
        # recipient_name, recipient_categories, vendor_known are added
        # by training/enrich.ts before this script ever sees the data.
        redemption_view = {
            "recipient_domain": redemption.get("recipient_domain"),
            "recipient_name": redemption.get("recipient_name"),
            "recipient_categories": redemption.get(
                "recipient_categories", []
            ),
            "vendor_known": redemption.get("vendor_known", False),
            "amount_usdc": redemption.get("amount_usdc"),
            "resource_description": redemption.get("resource_description"),
        }
        # separators=(",", ":") matches JS JSON.stringify default; ensure_ascii=False
        # keeps unicode raw (Python escapes — to — by default; JS does not).
        # Both required for byte-identical training/eval prompts.
        # See scripts/verify-prompt-parity.ts.
        user_msg = (
            f"INTENT: {case['intent']}\n"
            f"MANDATE_SUMMARY: {json.dumps(mandate, separators=(',', ':'), ensure_ascii=False)}\n"
            f"REDEMPTION: {json.dumps(redemption_view, separators=(',', ':'), ensure_ascii=False)}"
        )
        assistant_msg = (
            f"VERDICT: {case['expected_verdict']}\n"
            f"REASONING: {case['expected_reasoning']}"
        )
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
            {"role": "assistant", "content": assistant_msg},
        ]
        return tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=False
        )

    cases = []
    with open("/training-data.jsonl") as f:
        for line in f:
            cases.append(json.loads(line))
    print(f"Loaded {len(cases)} training cases")

    # Hold out the last 50 cases as validation. The generator emits in
    # archetype order, so this gives the val set a slice of the final
    # archetypes (edge / unknown vendor) — useful as a stress signal.
    train_cases = cases[:-50]
    val_cases = cases[-50:]
    print(f"Split: train={len(train_cases)} val={len(val_cases)}")

    train_ds = Dataset.from_list([{"text": format_case(c)} for c in train_cases])
    val_ds = Dataset.from_list([{"text": format_case(c)} for c in val_cases])

    training_args = SFTConfig(
        output_dir="/models/goldseel-checkpoints",
        per_device_train_batch_size=4,
        gradient_accumulation_steps=4,
        warmup_steps=10,
        num_train_epochs=2,
        learning_rate=1e-4,
        fp16=not torch.cuda.is_bf16_supported(),
        bf16=torch.cuda.is_bf16_supported(),
        logging_steps=5,
        optim="paged_adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="cosine",
        seed=42,
        max_seq_length=2048,
        dataset_text_field="text",
        report_to="none",
        eval_strategy="epoch",
        per_device_eval_batch_size=4,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        args=training_args,
    )

    print("Starting training...")
    trainer_stats = trainer.train()
    print(f"Training complete. Final train loss: {trainer_stats.training_loss}")

    # Pull per-epoch eval losses from the trainer's log history
    eval_losses = [
        log["eval_loss"] for log in trainer.state.log_history
        if "eval_loss" in log
    ]
    final_eval_loss = eval_losses[-1] if eval_losses else None
    print(f"Per-epoch eval losses: {eval_losses}")
    print(f"Final eval loss: {final_eval_loss}")

    print("Merging LoRA into base...")
    model.save_pretrained_merged(
        "/models/goldseel-7b-v0.2.2-merged",
        tokenizer,
        save_method="merged_16bit",
    )

    # Commit merged weights before GGUF so they survive any GGUF failure
    volume.commit()
    print("Merged 16-bit weights committed to volume.")

    print("Converting to GGUF Q4_K_M...")
    model.save_pretrained_gguf(
        "/models/goldseel-7b-v0.2.2",
        tokenizer,
        quantization_method="q4_k_m",
    )

    # Commit GGUF artifacts
    volume.commit()

    return {
        "train_loss": trainer_stats.training_loss,
        "eval_losses_per_epoch": eval_losses,
        "final_eval_loss": final_eval_loss,
        "epochs": 2,
        "train_cases": len(train_cases),
        "val_cases": len(val_cases),
    }


@app.local_entrypoint()
def main():
    result = finetune.remote()
    print(json.dumps(result, indent=2))
