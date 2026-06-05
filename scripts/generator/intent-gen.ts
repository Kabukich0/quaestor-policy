// LLM-backed intent generator. Batches heavily to amortise rate limits.
//
// Contract: given an archetype + vendor + scenario, return N distinct intent
// strings, each one passing the archetype's intent_constraints.

import type { Archetype, IntentConstraints, Scenario, VendorPick } from './types.js';

const BASE = process.env.LITELLM_BASE_URL
  ? `${process.env.LITELLM_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`
  : null;
const API_KEY = process.env.LITELLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL ?? 'tier-quality';

if (!BASE || !API_KEY) {
  throw new Error('intent-gen requires LITELLM_BASE_URL + LITELLM_API_KEY');
}

interface LlmResponse {
  choices?: { message: { content: string } }[];
  error?: { message: string };
}

let inflight = 0;
const MAX_INFLIGHT = Number(process.env.CONCURRENCY ?? '3');

async function awaitSlot(): Promise<void> {
  while (inflight >= MAX_INFLIGHT) {
    await new Promise((r) => setTimeout(r, 50));
  }
  inflight += 1;
}

async function fetchWithBackoff(body: string, maxRetries = 6): Promise<Response | null> {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const res = await fetch(BASE as string, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`,
        },
        body,
      });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.min(60_000, 1000 * 2 ** attempt);
        const peek = (await res.text()).slice(0, 120);
        process.stderr.write(`  [backoff] HTTP ${res.status} (attempt ${attempt + 1}/${maxRetries}), wait ${wait}ms; ${peek}\n`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return res; // non-retryable 4xx
    } catch (e) {
      const wait = Math.min(60_000, 1000 * 2 ** attempt);
      process.stderr.write(`  [backoff] fetch error (attempt ${attempt + 1}/${maxRetries}), wait ${wait}ms: ${(e as Error).message}\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return null;
}

async function llmCall(system: string, user: string): Promise<string> {
  await awaitSlot();
  try {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const res = await fetchWithBackoff(body);
    if (!res) return '';
    if (!res.ok) {
      const peek = (await res.text()).slice(0, 120);
      process.stderr.write(`  llm HTTP ${res.status}: ${peek}\n`);
      return '';
    }
    const json = (await res.json()) as LlmResponse;
    if (json.error) {
      process.stderr.write(`  llm error: ${json.error.message?.slice(0, 120)}\n`);
      return '';
    }
    return json.choices?.[0]?.message?.content ?? '';
  } finally {
    inflight -= 1;
  }
}

function buildSystem(archetype: Archetype): string {
  return [
    'You generate one-sentence payment-mandate intents for training a policy classifier.',
    '',
    'Output strictly: a JSON object {"intents": [<string>, <string>, ...]}.',
    'Each intent is ONE sentence (≤140 chars), lowercase, no quotes, no leading "Intent:".',
    'Tone: terse business-mandate description, NOT marketing copy.',
    '',
    `Archetype: ${archetype.id} (${archetype.rule}).`,
    `Verdict the policy should reach on these intents: ${archetype.verdict}.`,
  ].join('\n');
}

function buildUser(constraints: IntentConstraints, vendor: VendorPick | null, n: number, scenario: Scenario): string {
  const lines: string[] = [`Generate ${n} DIFFERENT one-sentence intents.`];
  if (constraints.must_authorize_categories?.length) {
    lines.push(`Each MUST authorize at least one of: ${constraints.must_authorize_categories.join(', ')}. The intent text should make this authorization plausible to a human reader (mention the category, sector, or use case).`);
  }
  if (constraints.must_forbid_categories?.length) {
    lines.push(`Each MUST explicitly forbid: ${constraints.must_forbid_categories.join(', ')}. Use phrasing like "no <X>", "never <X>", "no <X> tools", "exclude <X>".`);
  }
  if (constraints.must_contain_keywords?.length) {
    lines.push(`Each intent MUST contain ALL of these keywords (case-insensitive substring): ${constraints.must_contain_keywords.map((k) => `"${k}"`).join(', ')}.`);
  }
  if (constraints.must_not_contain_keywords?.length) {
    lines.push(`Each intent MUST NOT contain any of these substrings (case-insensitive): ${constraints.must_not_contain_keywords.map((k) => `"${k}"`).join(', ')}.`);
  }
  if (vendor) {
    lines.push(`The redemption is to vendor ${vendor.name} (${vendor.domain}), categories [${vendor.categories.join(', ')}].`);
  } else {
    lines.push(`The redemption is to an unknown vendor at ${(scenario.vars.domain as string) ?? '<unknown>'}.`);
  }
  lines.push('');
  lines.push('JSON only.');
  return lines.join('\n');
}

function validateIntent(text: string, constraints: IntentConstraints): boolean {
  const t = text.toLowerCase().trim();
  if (t.length < 10 || t.length > 240) return false;
  if (t.startsWith('intent:')) return false;
  if (t.includes('"') && (t.match(/"/g)?.length ?? 0) > 1) return false;
  for (const k of constraints.must_contain_keywords ?? []) {
    if (!k) continue;
    if (!t.includes(k.toLowerCase())) return false;
  }
  for (const k of constraints.must_not_contain_keywords ?? []) {
    if (!k) continue;
    if (t.includes(k.toLowerCase())) return false;
  }
  return true;
}

interface IntentBatch {
  intents: string[];
}

export async function generateIntents(
  archetype: Archetype,
  vendor: VendorPick | null,
  scenario: Scenario,
  n: number,
): Promise<string[]> {
  const constraints = archetype.intent_constraints(scenario);
  const system = buildSystem(archetype);
  const valid: string[] = [];
  const seen = new Set<string>();
  let totalAttempts = 0;
  const targetBatch = Math.max(8, Math.min(15, n + 5));

  while (valid.length < n && totalAttempts < 6) {
    totalAttempts += 1;
    const need = n - valid.length;
    const askFor = Math.max(targetBatch, need + 5);
    const user = buildUser(constraints, vendor, askFor, scenario);
    const raw = await llmCall(system, user);
    if (!raw) continue;
    let parsed: IntentBatch;
    try {
      const obj = JSON.parse(raw.trim());
      parsed = obj.intents ? obj : { intents: Array.isArray(obj) ? obj : [] };
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.intents)) continue;
    for (const candidate of parsed.intents) {
      if (typeof candidate !== 'string') continue;
      const lower = candidate.toLowerCase().trim();
      if (seen.has(lower)) continue;
      if (!validateIntent(candidate, constraints)) continue;
      seen.add(lower);
      valid.push(candidate.trim());
      if (valid.length >= n) break;
    }
  }
  return valid;
}
