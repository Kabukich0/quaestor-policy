/**
 * Prompt construction for the policy LLM.
 *
 * Why a fixed schema:
 *   - The model emits structured JSON so the daemon can deterministically
 *     parse it. No free-form output.
 *   - The schema is closed (additionalProperties=false) so a confused
 *     model can't slip extra fields past us.
 *   - Confidence is a number in [0,1]; "verdict" is one of two literals.
 */

export interface MandateSummary {
  spend_cap_remaining: string;
  recipient_policy: string;
  expiry_iso: string;
  use_counter_remaining: number;
}

export interface RedemptionContext {
  recipient_address: string;
  recipient_domain?: string;
  amount_usdc: string;
  resource_description?: string;
}

export interface PromptInput {
  intent: string;
  mandate_summary: MandateSummary;
  redemption: RedemptionContext;
}

/** JSON schema embedded in the prompt — also given to the grammar. */
export const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['verdict', 'confidence', 'reasoning'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'reject'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string', maxLength: 500 },
  },
} as const;

/**
 * System prompt: explains the role and the decision rubric. We intentionally
 * keep it short — Qwen 2.5 3B follows ~200-token instructions reliably; longer
 * preambles dilute confidence.
 */
export const SYSTEM_PROMPT = `You are a payment policy auditor. Decide whether a redemption matches the user's stated intent. Output ONE JSON: {"verdict":"approve"|"reject","confidence":0..1,"reasoning":"<240 chars"}.

DECISION RULES, in order:

1. NEGATIVE INTENT — reject hard.
   Intent says "no X", "never X", "only Y" (excludes non-Y), AND recipient is in the excluded category → reject 0.90+.
   ex: "no marketing tools" + mailchimp.com → reject 0.92. "never gambling" + draftkings.com → reject 0.95. "infra-only, never entertainment" + netflix.com → reject 0.92.

2. CATEGORY MISMATCH — reject.
   Recipient's actual sector is clearly different from intent's sector, even if intent is broad → reject 0.85+.
   ex: "saas for engineering team" + stockx.com (sneakers) → reject 0.90. "developer tools" + tinder.com (dating) → reject 0.95. "developer docs" + spotify.com (music) → reject 0.95. "open source tip jar" + robinhood.com (stocks) → reject 0.90. "back-office accounting" + etsy.com (retail) → reject 0.90.

3. CLEAR DIRECT MATCH — approve hard.
   Household-name vendor for intent's category → approve 0.90+. Do NOT call these "ambiguous".
   ex: "stock photo" + shutterstock.com → approve 0.95. "vercel hosting" + vercel.com → approve 0.95. "fastly cdn" + fastly.com → approve 0.95.

4. BROAD POSITIVE INTENT, KNOWN VENDOR — approve.
   Intent says "dev tools" / "infrastructure" / "engineering ops" and recipient is a known vendor in that sector → approve 0.85.
   - "dev tools" includes: analytics+observability+monitoring (posthog, sentry, datadog), CI (circleci), code hosting (github, gitlab), IDE (jetbrains, raycast), kanban (linear), design (figma), comms for engineering (slack), email APIs (postmark, sendgrid, twilio), ML APIs (openai, anthropic).
   - "infrastructure" includes: hosting, compute, storage, CDN, DNS, databases, SSL.
   - SaaS does NOT mean any subscription — it means business/productivity software you log into.
   ex: "dev tools and analytics" + posthog.com → approve 0.88. "infra spend" + aws.amazon.com → approve 0.90.

5. NOVEL DOMAIN — judge by resource_description.
   If domain unfamiliar, use resource_description. If it matches intent's category → approve 0.70-0.80 (do NOT punish novelty alone). If unrelated → reject 0.75+.
   ex: "infra spend" + tier4-cloud.io + "compute instance" → approve 0.75. "$5 agent micro-payments" + unknown.shop + "small purchase" → approve 0.70.

6. SUSPICIOUS DOMAIN — reject.
   Phishy/scam domains (free-iphone-prize.xyz, casino-online-bet.tk) → reject 0.95.

Do NOT enforce spend cap, expiry, or use counter (handled separately). Focus only on intent-vs-redemption fit. Output JSON only.`;

/**
 * Build the user-side message containing the structured facts. Intent is
 * placed last so the model attends to it most strongly.
 */
export function buildUserPrompt(input: PromptInput): string {
  const lines = [
    '## Mandate',
    `- spend cap remaining: ${input.mandate_summary.spend_cap_remaining}`,
    `- recipient policy: ${input.mandate_summary.recipient_policy}`,
    `- expires: ${input.mandate_summary.expiry_iso}`,
    `- use counter remaining: ${input.mandate_summary.use_counter_remaining}`,
    '',
    '## Redemption',
    `- recipient address: ${input.redemption.recipient_address}`,
    input.redemption.recipient_domain
      ? `- recipient domain: ${input.redemption.recipient_domain}`
      : '- recipient domain: (none)',
    `- amount: ${input.redemption.amount_usdc} USDC`,
    input.redemption.resource_description
      ? `- resource: ${input.redemption.resource_description}`
      : '- resource: (unspecified)',
    '',
    '## Intent (the user described what this mandate is for)',
    input.intent,
    '',
    'Return your JSON verdict now.',
  ];
  return lines.join('\n');
}

/** A single retry prompt — used if the first attempt produces unparseable JSON. */
export function buildRetryPrompt(input: PromptInput, badOutput: string): string {
  return `${buildUserPrompt(input)}

Your previous reply was not valid JSON matching the schema:
\`\`\`
${badOutput.slice(0, 400)}
\`\`\`

Reply ONLY with a JSON object containing exactly these three keys: verdict (string "approve" or "reject"), confidence (number 0..1), reasoning (string).`;
}
