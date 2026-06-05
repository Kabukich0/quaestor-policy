/**
 * Pure parser for the model's structured output (Goldseel v0.2.0).
 *
 * The v0.2.0 fine-tune emits plain text:
 *   VERDICT: approve|reject
 *   REASONING: <one sentence>
 *
 * For backward compat, the parser also accepts the old JSON shape
 * ({verdict, confidence, reasoning}) so the old v0.1.0 GGUF can still
 * be smoke-tested through the harness without a code change.
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

const VERDICT_LINE = /VERDICT\s*[:=]\s*(approve|reject)\b/i;
const REASONING_LINE = /REASONING\s*[:=]\s*([\s\S]*?)(?:\n\s*VERDICT|\n\s*REASONING|\n\s*$|$)/i;

export function parseModelOutput(raw: string): ParseResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'empty_output' };

  // 1. Plain-text VERDICT/REASONING (Goldseel v0.2.0 format)
  const verdictMatch = text.match(VERDICT_LINE);
  if (verdictMatch?.[1]) {
    const verdict = verdictMatch[1].toLowerCase() as 'approve' | 'reject';
    const reasoningMatch = text.match(REASONING_LINE);
    const reasoning = (reasoningMatch?.[1] ?? '').trim() || `(no reasoning given for ${verdict})`;
    const result = VerdictSchema.safeParse({
      verdict,
      confidence: 1.0, // v0.2.0 model doesn't emit confidence; fix at 1.0
      reasoning: reasoning.slice(0, 2000),
    });
    if (!result.success) return { ok: false, error: `schema_violation: ${result.error.message}` };
    return { ok: true, verdict: result.data };
  }

  // 2. JSON envelope (legacy v0.1.0 format)
  const json = extractJson(text);
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return { ok: false, error: `json_parse_failed: ${(e as Error).message}` };
    }
    const result = VerdictSchema.safeParse(parsed);
    if (!result.success) return { ok: false, error: `schema_violation: ${result.error.message}` };
    return { ok: true, verdict: result.data };
  }

  return { ok: false, error: 'no_verdict_found' };
}

function extractJson(raw: string): string | null {
  const stripped = raw.trim();
  if (stripped.startsWith('{') && stripped.endsWith('}')) return stripped;
  const fence = stripped.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (fence?.[1]) return fence[1];
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) return stripped.slice(first, last + 1);
  return null;
}
