/**
 * Per-token pricing for the Claude model used by Paperfile. Used purely
 * for cost display — Anthropic bills you directly on actual token use,
 * these numbers are just so the UI can show "AI cost: €0.04" per doc.
 *
 * Update when Anthropic changes pricing or we switch models.
 * Last verified: 2026-05 (Claude Sonnet 4).
 */

export const AI_MODEL = "claude-sonnet-4-20250514";

// USD per 1M tokens
export const AI_RATE_INPUT_USD_PER_MTOK = 3.0;
export const AI_RATE_OUTPUT_USD_PER_MTOK = 15.0;

// Rough USD → EUR conversion. Anthropic bills in USD; UI display in EUR.
// Refresh once a year or so — error of a few % doesn't matter for display.
export const AI_USD_TO_EUR = 0.93;

export function estimateAiCostEur(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined
): number {
  const inT = Number(inputTokens) || 0;
  const outT = Number(outputTokens) || 0;
  const usd =
    (inT / 1_000_000) * AI_RATE_INPUT_USD_PER_MTOK +
    (outT / 1_000_000) * AI_RATE_OUTPUT_USD_PER_MTOK;
  return usd * AI_USD_TO_EUR;
}

export function formatAiCostEur(eur: number): string {
  if (eur < 0.01) return `<€0.01`;
  return `€${eur.toFixed(2)}`;
}

/**
 * Output-cap presets.
 *
 * claude-sonnet-4-20250514's hard ceiling is 64,000 output tokens — the
 * API rejects anything above that with an invalid_request_error. The
 * 128k extended-output beta (`output-128k-2025-02-19`) applies only to
 * claude-3-7-sonnet, NOT Sonnet 4, so there is no "extended" cap to
 * reach for on this model.
 *
 *   - DEFAULT:  64,000 — the model's max; handles ~250-transaction PDFs.
 *               max_tokens is a ceiling, not a target — generation stops
 *               when the JSON is complete, usually well under 20k.
 *   - EXTENDED: same as DEFAULT on Sonnet 4. Kept as a named constant so
 *               the "Retry full" code path still compiles; it just no
 *               longer requests more than the model allows.
 */
export const AI_MAX_TOKENS_DEFAULT = 64_000;
export const AI_MAX_TOKENS_EXTENDED = 64_000;
export const AI_EXTENDED_BETA_HEADER = "output-128k-2025-02-19";
