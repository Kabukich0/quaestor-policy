// One-case smoke test through the v0.1.0 GGUF.
// Bypasses the modelExists() pin (which expects the base Qwen). Loads the
// finetuned GGUF directly and runs ONE case through the new prompt format.
// Confirms: model loads, harness builds prompt, output is parseable.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUserPrompt, SYSTEM_PROMPT } from '../src/prompt.js';
import { parseModelOutput } from '../src/parse.js';
import type { EnrichedCase } from '../eval/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const GGUF = path.join(REPO, 'training', 'quaestor-goldseel-3b-v0.1.0.gguf');

const cases: EnrichedCase[] = JSON.parse(
  readFileSync(path.join(REPO, 'eval', 'cases-v0.2.0-enriched.json'), 'utf8'),
);
const c = cases.find((x) => x.id === 'approve-001') ?? cases[0];

console.log(`smoke: case ${c.id} (${c.category}) — expected ${c.expected_verdict}`);
const userPrompt = buildUserPrompt({
  intent: c.intent,
  mandate_summary: c.mandate_summary,
  redemption: c.redemption,
});
console.log(`smoke: user prompt (${userPrompt.length} chars):`);
console.log(userPrompt);
console.log(`smoke: loading model from ${GGUF}…`);

// biome-ignore lint/suspicious/noExplicitAny: node-llama-cpp dynamic
const llamaMod: any = await import('node-llama-cpp');
const llama = await llamaMod.getLlama();
const t0 = Date.now();
const model = await llama.loadModel({ modelPath: GGUF });
console.log(`smoke: model loaded in ${Date.now() - t0}ms`);

const ctx = await model.createContext({ contextSize: 2048 });
const session = new llamaMod.LlamaChatSession({
  contextSequence: ctx.getSequence(),
  systemPrompt: SYSTEM_PROMPT,
});

const t1 = Date.now();
const out = await session.prompt(userPrompt, { maxTokens: 200, temperature: 0.1, topP: 0.9 });
const latency = Date.now() - t1;
console.log(`\nsmoke: model output (${latency}ms):`);
console.log(String(out));

const parsed = parseModelOutput(String(out));
console.log(`\nsmoke: parse result:`);
console.log(JSON.stringify(parsed, null, 2));

await ctx.dispose();
process.exit(parsed.ok ? 0 : 1);
