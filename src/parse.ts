/**
 * Pure parser for the model's structured output. Lives in its own module so
 * unit tests cover every malformed-output branch without spinning up llama.cpp.
 */
import { z } from 'zod';

export const VerdictSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
});

export type Verdict = z.infer<typeof VerdictSchema>;

export interface ParseResult {
  ok: boolean;
  verdict?: Verdict;
  error?: string;
}

/**
 * Try to parse the model's raw text into a Verdict.
 *
 * The model is supposed to emit JSON only thanks to grammar constraints, but
 * we still defensively strip ``` fences and surrounding prose because:
 *   - Some quantized models leak a leading newline before the JSON.
 *   - Adapters in node-llama-cpp occasionally include a trailing eos string.
 */
export function parseModelOutput(raw: string): ParseResult {
  const trimmed = extractJson(raw);
  if (!trimmed) return { ok: false, error: 'no_json_object_found' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `json_parse_failed: ${(e as Error).message}` };
  }
  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `schema_violation: ${result.error.message}` };
  }
  return { ok: true, verdict: result.data };
}

function extractJson(raw: string): string | null {
  const stripped = raw.trim();
  if (stripped.startsWith('{') && stripped.endsWith('}')) return stripped;
  // Strip ``` fences.
  const fence = stripped.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (fence?.[1]) return fence[1];
  // Last-resort: first { … last }. Bracket-balanced match avoids nested-brace issues.
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) return stripped.slice(first, last + 1);
  return null;
}
