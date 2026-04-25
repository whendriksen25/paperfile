import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentExtraction, ProfileRow } from "@/types/document";

/**
 * Pull a YYYY year out of either a structured date string ("1936-07-27",
 * "27-07-1936", "27/07/1936") or freeform text. Returns null if no plausible
 * birth year is found.
 */
function extractYear(input: unknown): number | null {
  if (input == null) return null;
  const s = String(input);
  // Look for a 4-digit year between 1900 and current year
  const matches = s.match(/\b(19\d{2}|20\d{2})\b/g);
  if (!matches || matches.length === 0) return null;
  const now = new Date().getFullYear();
  for (const m of matches) {
    const y = Number(m);
    if (y >= 1900 && y <= now) return y;
  }
  return null;
}

/** Lowercase, trim, strip non-alphanumerics — for fuzzy text comparison. */
function norm(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Strict IBAN normalisation — uppercase, no whitespace. */
function ibanNorm(s: unknown): string {
  return String(s ?? "").toUpperCase().replace(/\s+/g, "");
}

/**
 * The signals we'll look for in each profile, derived from its structured
 * attributes AND its free-text description (so descriptions like
 * "Born 1936, lives in Dieren" still produce hard signals).
 */
interface ProfileSignals {
  profile: ProfileRow;
  birthYear: number | null;
  cities: Set<string>;
  postalCodes: Set<string>;
  ibans: Set<string>;
  bsns: Set<string>;
  patientNumbers: Set<string>;
  policyNumbers: Set<string>;
  customerNumbers: Set<string>;
}

function signalsFor(profile: ProfileRow): ProfileSignals {
  const a = (profile.attributes || {}) as Record<string, string>;
  const desc = profile.description || "";

  const cities = new Set<string>();
  if (a.city) cities.add(norm(a.city));
  // Also match any standalone capitalised word in description that looks
  // like a place name. Lazy heuristic — Dutch city lists would be better,
  // but covers "Dieren", "Amsterdam", etc. Single-word, length >= 3.
  for (const word of desc.split(/[\s,.;]+/)) {
    if (/^[A-Z][a-zA-ZëïéüöáíóúÄëïöü]{2,}$/.test(word)) {
      cities.add(norm(word));
    }
  }

  const postalCodes = new Set<string>();
  if (a.postal_code) postalCodes.add(norm(a.postal_code));
  // Dutch postal codes (1234 AB) — match anywhere in description
  Array.from(desc.matchAll(/\b(\d{4}\s*[A-Z]{2})\b/g)).forEach((m) =>
    postalCodes.add(norm(m[1]))
  );

  const ibans = new Set<string>();
  if (a.iban) ibans.add(ibanNorm(a.iban));
  // Match an IBAN-shaped token in the description
  Array.from(desc.matchAll(/\b([A-Z]{2}\d{2}[A-Z0-9]{4,30})\b/g)).forEach((m) =>
    ibans.add(ibanNorm(m[1]))
  );

  const collectNumbers = (key: string): Set<string> => {
    const s = new Set<string>();
    if (a[key]) s.add(norm(a[key]));
    return s;
  };

  return {
    profile,
    birthYear: extractYear(a.birth_date) ?? extractYear(desc),
    cities,
    postalCodes,
    ibans,
    bsns: collectNumbers("bsn"),
    patientNumbers: collectNumbers("patient_number"),
    policyNumbers: collectNumbers("policy_number"),
    customerNumbers: collectNumbers("customer_number"),
  };
}

/**
 * The signals we extracted FROM the document being filed.
 */
interface DocumentSignals {
  birthYear: number | null;
  cities: Set<string>;
  postalCodes: Set<string>;
  ibans: Set<string>;
  bsns: Set<string>;
  patientNumbers: Set<string>;
  policyNumbers: Set<string>;
  customerNumbers: Set<string>;
}

function signalsForDocument(extraction: DocumentExtraction): DocumentSignals {
  const ef = (extraction.extracted_fields || {}) as Record<string, unknown>;
  const ocr = extraction.ocr_text || "";
  const all = `${ocr}\n${JSON.stringify(ef)}`;

  const cities = new Set<string>();
  if (ef.city) cities.add(norm(ef.city));
  if (ef.address) {
    // Crude — last word of address often the city
    const last = String(ef.address).trim().split(/\s+/).pop();
    if (last) cities.add(norm(last));
  }

  const postalCodes = new Set<string>();
  if (ef.postal_code) postalCodes.add(norm(ef.postal_code));
  Array.from(all.matchAll(/\b(\d{4}\s*[A-Z]{2})\b/g)).forEach((m) =>
    postalCodes.add(norm(m[1]))
  );

  const ibans = new Set<string>();
  if (ef.iban) ibans.add(ibanNorm(ef.iban));
  Array.from(all.matchAll(/\b([A-Z]{2}\d{2}[A-Z0-9]{4,30})\b/g)).forEach((m) =>
    ibans.add(ibanNorm(m[1]))
  );

  const numberFromAll = (key: string, len = 8): Set<string> => {
    const s = new Set<string>();
    if (ef[key]) s.add(norm(ef[key]));
    return s;
  };

  return {
    birthYear: extractYear(ef.birth_date),
    cities,
    postalCodes,
    ibans,
    bsns: numberFromAll("bsn"),
    patientNumbers: numberFromAll("patient_number"),
    policyNumbers: numberFromAll("policy_number"),
    customerNumbers: numberFromAll("customer_number"),
  };
}

/**
 * Try to match the document to a single profile based ONLY on hard,
 * deterministic identifiers — birth year, city, postal code, IBAN, BSN,
 * patient/policy/customer number. Skips Claude entirely.
 *
 * Returns the matched profile + a human-readable reason if (and only if)
 * EXACTLY ONE profile uniquely matches at least one strong identifier.
 * Returns null when zero or multiple profiles tie — those cases fall
 * through to the existing AI-based suggestProfile.
 *
 * Why: a bill with `birth_date: 27-07-1936` and a Father profile whose
 * description is "Born 1936, lives in Dieren" should never need fuzzy AI
 * scoring. The year alone uniquely identifies Father; that's a binary
 * fact the system should treat as 1.0 confidence.
 */
export function deterministicProfileMatch(
  extraction: DocumentExtraction,
  profiles: ProfileRow[]
): { profile: ProfileRow; reason: string } | null {
  if (!profiles.length) return null;

  const docSig = signalsForDocument(extraction);
  const profSigs = profiles.map(signalsFor);

  // Each entry: list of profiles that share this signal with the doc, plus
  // the human-readable reason text we'd cite.
  const checks: { reason: (p: ProfileRow) => string; matches: ProfileSignals[] }[] = [];

  // BSN — gold standard
  if (docSig.bsns.size) {
    const m = profSigs.filter((p) => Array.from(p.bsns).some((b) => docSig.bsns.has(b)));
    if (m.length) checks.push({ reason: () => `BSN matches profile attribute`, matches: m });
  }
  // IBAN
  if (docSig.ibans.size) {
    const m = profSigs.filter((p) =>
      Array.from(p.ibans).some((i) => docSig.ibans.has(i))
    );
    if (m.length) checks.push({ reason: () => `IBAN matches profile attribute or description`, matches: m });
  }
  // Patient number
  if (docSig.patientNumbers.size) {
    const m = profSigs.filter((p) =>
      Array.from(p.patientNumbers).some((n) => docSig.patientNumbers.has(n))
    );
    if (m.length) checks.push({ reason: () => `Patient number matches profile attribute`, matches: m });
  }
  // Policy number
  if (docSig.policyNumbers.size) {
    const m = profSigs.filter((p) =>
      Array.from(p.policyNumbers).some((n) => docSig.policyNumbers.has(n))
    );
    if (m.length) checks.push({ reason: () => `Policy number matches profile attribute`, matches: m });
  }
  // Customer number
  if (docSig.customerNumbers.size) {
    const m = profSigs.filter((p) =>
      Array.from(p.customerNumbers).some((n) => docSig.customerNumbers.has(n))
    );
    if (m.length) checks.push({ reason: () => `Customer number matches profile attribute`, matches: m });
  }
  // Postal code
  if (docSig.postalCodes.size) {
    const m = profSigs.filter((p) =>
      Array.from(p.postalCodes).some((pc) => docSig.postalCodes.has(pc))
    );
    if (m.length) checks.push({ reason: () => `Postal code matches profile attribute or description`, matches: m });
  }
  // Birth year — strong signal, especially at the family level
  if (docSig.birthYear != null) {
    const m = profSigs.filter((p) => p.birthYear === docSig.birthYear);
    if (m.length) checks.push({ reason: () => `Birth year ${docSig.birthYear} matches profile attribute or description`, matches: m });
  }
  // City — soft but cumulative
  if (docSig.cities.size) {
    const m = profSigs.filter((p) =>
      Array.from(p.cities).some((c) => docSig.cities.has(c))
    );
    if (m.length) checks.push({ reason: () => `City matches profile attribute or description`, matches: m });
  }

  // Look for a UNIQUE match: at least one signal where exactly one profile matched
  for (const check of checks) {
    if (check.matches.length === 1) {
      const winner = check.matches[0];
      return {
        profile: winner.profile,
        reason: `Deterministic: ${check.reason(winner.profile)} (${winner.profile.name}).`,
      };
    }
  }

  // No single signal pins it down — but if the SAME profile is the unique
  // match across multiple signals (e.g. birth year + city both point at
  // Father), we trust it even if each signal alone matched several profiles.
  // Score profiles by number of matched signals where they're a candidate.
  const scoreById = new Map<number, number>();
  for (const check of checks) {
    for (const m of check.matches) {
      scoreById.set(m.profile.id, (scoreById.get(m.profile.id) || 0) + 1);
    }
  }
  if (scoreById.size > 0) {
    const sorted = Array.from(scoreById.entries()).sort((a, b) => b[1] - a[1]);
    const [topId, topScore] = sorted[0];
    const second = sorted[1];
    // Top has at least 2 signal matches AND beats the runner-up by a margin
    if (topScore >= 2 && (!second || topScore - second[1] >= 1)) {
      const winner = profSigs.find((p) => p.profile.id === topId);
      if (winner) {
        return {
          profile: winner.profile,
          reason: `Deterministic: ${topScore} identifying signals point at ${winner.profile.name}.`,
        };
      }
    }
  }

  return null;
}

/**
 * Best-effort fuzzy match between a profile_hint string (the human name as it
 * appears on a document) and the user's existing profiles.
 *
 * Strategy:
 *   1. Exact name match (case insensitive) wins
 *   2. Otherwise: token overlap — count how many words from the hint appear
 *      in the profile name. Highest overlap wins, ties broken by length proximity.
 *   3. Returns null if no profile shares any token.
 */
export function matchProfileByHint(
  hint: string | null | undefined,
  profiles: ProfileRow[]
): ProfileRow | null {
  if (!hint || profiles.length === 0) return null;
  const h = hint.toLowerCase().trim();

  // 1. Exact match
  const exact = profiles.find((p) => p.name.toLowerCase().trim() === h);
  if (exact) return exact;

  // 2. Token overlap
  const hintTokens = new Set(
    h.split(/\W+/).filter((t) => t.length >= 2)
  );
  if (hintTokens.size === 0) return null;

  const hintArr = Array.from(hintTokens);
  let best: { profile: ProfileRow; score: number } | null = null;
  for (const p of profiles) {
    const pTokens = new Set(
      p.name
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length >= 2)
    );
    let overlap = 0;
    for (const t of hintArr) if (pTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    if (!best || overlap > best.score) {
      best = { profile: p, score: overlap };
    }
  }
  return best?.profile || null;
}

/**
 * Loads all profiles for the current user from a Supabase admin client.
 */
export async function listProfilesForUser(
  admin: SupabaseClient,
  userId: string
): Promise<ProfileRow[]> {
  const { data } = await admin
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("name");
  return (data || []) as ProfileRow[];
}

/**
 * Returns the user's default profile, creating one if none exists.
 */
export async function ensureDefaultProfile(
  admin: SupabaseClient,
  userId: string
): Promise<ProfileRow> {
  const profiles = await listProfilesForUser(admin, userId);
  const def = profiles.find((p) => p.is_default);
  if (def) return def;

  const fallback = profiles[0];
  if (fallback) return fallback;

  const { data, error } = await admin
    .from("profiles")
    .insert({
      user_id: userId,
      name: "Me",
      type: "person",
      is_default: true,
    })
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`Failed to create default profile: ${error?.message}`);
  }
  return data as ProfileRow;
}
