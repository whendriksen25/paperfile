import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Look up the user's classification history for a given sender.
 *
 * The system learns dynamically: every doc the user has filed (and especially
 * every doc they've corrected via Refile) is evidence about how documents
 * from a particular sender should be categorised. When a new doc arrives
 * from the same sender, that history beats Claude's one-shot guess.
 *
 * Why this is preferable to hardcoded sender→type mappings:
 *  - it works for senders we've never thought of (Wim's specific insurer,
 *    the local council, his pension fund, etc. — all learned from his own
 *    archive without code changes)
 *  - it incorporates user corrections automatically (refile a doc and
 *    history updates, no settings page)
 *  - it's transparent — we can show the reason ("you've filed 6 prior
 *    documents from CAK as medical_bill")
 *
 * Match strategy: sender names rarely match exactly across scans (capitalisation,
 * extra address, "B.V." suffix, etc.) so we normalise: lowercase + alphanumerics
 * only + take the first 32 chars. This makes "CAK", "C.A.K.", "CAK Den Haag"
 * all collapse to the same key. A small false-positive risk in exchange for
 * useful recall.
 */

function normalizeSender(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
}

export interface SenderHistory {
  /** What the bulk of prior docs from this sender are typed as. */
  document_type: string;
  /** How many prior docs vote for that type. */
  votes: number;
  /** Total prior docs (regardless of which type). */
  total: number;
  /** votes / total — confidence proxy. */
  ratio: number;
  /** Of those votes, how many came from user-corrected (refiled) docs. */
  user_confirmed_votes: number;
  /** Brief human-readable explanation suitable for review notes. */
  reason: string;
}

/**
 * Pulls the dominant document_type for the given sender, scoped to one user.
 * Returns null if there's no usable signal — fewer than 2 prior docs, or
 * no clear winner (top type accounts for less than 60% of votes).
 *
 *  - Each prior doc casts one vote for its current document_type.
 *  - User-corrected (needs_review=false AND classified) docs get DOUBLE
 *    weight, since "user explicitly settled this" is stronger evidence
 *    than "Claude auto-classified this once."
 *  - The currently-being-analysed doc is excluded by `excludeDocId`.
 */
export async function getSenderHistory(
  admin: SupabaseClient,
  userId: string,
  senderRaw: string | null | undefined,
  excludeDocId: string | null
): Promise<SenderHistory | null> {
  const sNorm = normalizeSender(senderRaw);
  if (sNorm.length < 3) return null;

  // Pull all the user's processed docs that have a sender + document_type.
  // Filter on the client because Postgres doesn't have a cheap normalize-
  // and-prefix-match function for our normalisation rule. The dataset is
  // small (one user's archive) so this is fine.
  const { data: rows, error } = await admin
    .from("documents")
    .select("id, sender, document_type, needs_review, status")
    .eq("user_id", userId)
    .eq("status", "processed")
    .not("sender", "is", null)
    .not("document_type", "is", null);
  if (error) return null;
  if (!rows || rows.length === 0) return null;

  const matching = rows.filter(
    (r) =>
      r.id !== excludeDocId &&
      normalizeSender(r.sender as string) === sNorm
  );
  if (matching.length < 2) return null;

  // Tally with double weight for user-confirmed docs (needs_review=false).
  const tally = new Map<string, { votes: number; confirmed: number }>();
  for (const r of matching) {
    const t = r.document_type as string;
    const isConfirmed = r.needs_review === false;
    const weight = isConfirmed ? 2 : 1;
    const cur = tally.get(t) || { votes: 0, confirmed: 0 };
    cur.votes += weight;
    if (isConfirmed) cur.confirmed += 1;
    tally.set(t, cur);
  }

  const sorted = Array.from(tally.entries()).sort(
    (a, b) => b[1].votes - a[1].votes
  );
  const totalVotes = sorted.reduce((s, [, v]) => s + v.votes, 0);
  const [topType, topInfo] = sorted[0];
  const ratio = totalVotes ? topInfo.votes / totalVotes : 0;

  // Need a real majority to act on history. Below 60% means the sender
  // legitimately produces multiple types (e.g. an insurer sending both
  // policy docs and claim declarations), and we shouldn't flatten that.
  if (ratio < 0.6) return null;

  const reason = `History: ${matching.length} prior documents from "${senderRaw}" — ${topInfo.votes} votes for ${topType}${topInfo.confirmed ? ` (${topInfo.confirmed} user-confirmed)` : ""}.`;

  return {
    document_type: topType,
    votes: topInfo.votes,
    total: totalVotes,
    ratio,
    user_confirmed_votes: topInfo.confirmed,
    reason,
  };
}

export { normalizeSender };
