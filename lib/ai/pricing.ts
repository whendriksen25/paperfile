/**
 * Single source of truth for Claude model selection + pricing.
 *
 * ───────────────────────────────────────────────────────────────────────
 * HOW TO UPGRADE WHEN A BETTER CLAUDE MODEL ARRIVES
 * ───────────────────────────────────────────────────────────────────────
 *
 * Two paths:
 *
 *   A. EDIT THE CONSTANTS BELOW (requires a deploy)
 *      - Change AI_MODEL_SMART_DEFAULT / AI_MODEL_FAST_DEFAULT to the new
 *        model IDs from https://docs.claude.com/en/docs/about-claude/models
 *      - Update the per-Mtok pricing constants if Anthropic's pricing
 *        page lists different rates for the new model.
 *      - Commit + push. Vercel deploys, every call site uses the new model.
 *
 *   B. SET ENV VARS IN VERCEL (no deploy, takes effect immediately)
 *      - In Vercel project settings → Environment Variables:
 *          ANTHROPIC_MODEL_SMART=claude-sonnet-4-7-20260801
 *          ANTHROPIC_MODEL_FAST=claude-haiku-5-20260601
 *      - Redeploy is NOT required — the next serverless cold start picks
 *        them up. Use this for A/B testing a new model in production
 *        without code review.
 *
 * Path A keeps the code self-documenting (anyone reading the file sees
 * which model is in use). Path B lets you upgrade in 30 seconds without
 * a PR. Pick whichever fits the situation.
 *
 * Whenever you bump a model ID, also revisit `Last verified` below and
 * the per-token rates — Anthropic occasionally adjusts pricing.
 *
 * Last verified: 2026-05 — Claude Sonnet 4.6 + Claude Haiku 4.5.
 * Model lineup at the time:
 *   - claude-opus-4-6              (most capable, slow, expensive)
 *   - claude-sonnet-4-6            (default smart workhorse — what we use)
 *   - claude-haiku-4-5-20251001    (cheap + fast for ranking/classification)
 */

/**
 * "Smart" model — used for vision tasks, document extraction, profile
 * suggestion, profile enrichment, and any other call where reasoning
 * quality matters more than per-call latency or cost.
 *
 * Currently: Claude Sonnet 4.6. Override with ANTHROPIC_MODEL_SMART.
 */
export const AI_MODEL_SMART =
  process.env.ANTHROPIC_MODEL_SMART || "claude-sonnet-4-6";

/**
 * "Fast" model — used for cheap, high-volume classification work where
 * a 3× cost reduction + 3× latency reduction beats a marginal quality
 * gain. Today this is bank-reconciliation matching and taxonomy cleanup.
 *
 * Currently: Claude Haiku 4.5. Override with ANTHROPIC_MODEL_FAST.
 */
export const AI_MODEL_FAST =
  process.env.ANTHROPIC_MODEL_FAST || "claude-haiku-4-5-20251001";

/**
 * Legacy alias — older code may still import AI_MODEL expecting the
 * smart model. Kept so existing imports don't break.
 *
 * @deprecated Use AI_MODEL_SMART (or AI_MODEL_FAST) explicitly.
 */
export const AI_MODEL = AI_MODEL_SMART;

// ─── PRICING (USD per 1M tokens, as of 2026-05) ──────────────────────
//
// Source: https://docs.claude.com/en/docs/about-claude/pricing
//
// Sonnet tier (4.x family): $3 in / $15 out per Mtok
// Haiku tier  (4.x family): $1 in / $5  out per Mtok
//
// If you change the model IDs above, double-check these.

export const AI_RATE_SMART_INPUT_USD_PER_MTOK = 3.0;
export const AI_RATE_SMART_OUTPUT_USD_PER_MTOK = 15.0;

export const AI_RATE_FAST_INPUT_USD_PER_MTOK = 1.0;
export const AI_RATE_FAST_OUTPUT_USD_PER_MTOK = 5.0;

// Back-compat shims for older code that imports the un-suffixed names.
// Today these point at the smart-tier rates (which is what extraction
// uses, which is what AI cost display is dominated by).
export const AI_RATE_INPUT_USD_PER_MTOK = AI_RATE_SMART_INPUT_USD_PER_MTOK;
export const AI_RATE_OUTPUT_USD_PER_MTOK = AI_RATE_SMART_OUTPUT_USD_PER_MTOK;

// Rough USD → EUR conversion. Anthropic bills in USD; UI display in EUR.
// Refresh once a year or so — error of a few % doesn't matter for display.
export const AI_USD_TO_EUR = 0.93;

/** Estimate a call's cost in EUR. Pass which tier the call hit. */
export function estimateAiCostEur(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  tier: "smart" | "fast" = "smart"
): number {
  const inT = Number(inputTokens) || 0;
  const outT = Number(outputTokens) || 0;
  const inRate =
    tier === "fast"
      ? AI_RATE_FAST_INPUT_USD_PER_MTOK
      : AI_RATE_SMART_INPUT_USD_PER_MTOK;
  const outRate =
    tier === "fast"
      ? AI_RATE_FAST_OUTPUT_USD_PER_MTOK
      : AI_RATE_SMART_OUTPUT_USD_PER_MTOK;
  const usd = (inT / 1_000_000) * inRate + (outT / 1_000_000) * outRate;
  return usd * AI_USD_TO_EUR;
}

export function formatAiCostEur(eur: number): string {
  if (eur < 0.01) return `<€0.01`;
  return `€${eur.toFixed(2)}`;
}

/**
 * Output-cap presets.
 *
 * Sonnet 4.x's hard ceiling is 64,000 output tokens — the API rejects
 * anything above that with an invalid_request_error.
 *
 *   - DEFAULT:  64,000 — the model's max; handles ~250-transaction PDFs.
 *               max_tokens is a ceiling, not a target — generation stops
 *               when the JSON is complete, usually well under 20k.
 *   - EXTENDED: same as DEFAULT on Sonnet 4.x. Kept as a named constant
 *               so the "Retry full" code path still compiles; it just no
 *               longer requests more than the model allows.
 *
 * Revisit when bumping to a new model family — newer Sonnets may raise
 * this ceiling (Sonnet 3.7 had a 128k extended-output beta).
 */
export const AI_MAX_TOKENS_DEFAULT = 64_000;
export const AI_MAX_TOKENS_EXTENDED = 64_000;
export const AI_EXTENDED_BETA_HEADER = "output-128k-2025-02-19";
