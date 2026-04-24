import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  enrichProfileFromText,
  htmlToTextExcerpt,
} from "@/lib/ai/enrich-profile";

export const runtime = "nodejs";
export const maxDuration = 30;

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 800_000;

function normaliseUrl(input: string): string | null {
  let u = input.trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const url = new URL(u);
    // Only http/https; reject loopback / private hosts to avoid SSRF
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchTextWithLimits(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "PaperfileEnricher/1.0 (+https://paperfile.app) Mozilla/5.0",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      throw new Error(`Fetch failed: HTTP ${res.status}`);
    }
    const ctype = res.headers.get("content-type") || "";
    if (!/text\/html|xml|plain/i.test(ctype)) {
      throw new Error(`Unsupported content type: ${ctype}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");
    let received = 0;
    const chunks: Uint8Array[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES) {
        controller.abort();
        break;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return buf.toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/profiles/enrich
 * Body: { url: string }
 * Response: { data: { name, description, ai_summary, aliases, attributes } }
 */
export async function POST(request: NextRequest) {
  console.log("[api/profiles/enrich] start");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const url = normaliseUrl(String(body.url || ""));
  if (!url) {
    return NextResponse.json(
      { error: "Provide a valid public website URL" },
      { status: 400 }
    );
  }

  let html: string;
  try {
    html = await fetchTextWithLimits(url);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Could not fetch the URL";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const text = htmlToTextExcerpt(html);
  if (text.length < 80) {
    return NextResponse.json(
      { error: "Page text was too short to extract anything useful." },
      { status: 422 }
    );
  }

  try {
    const enriched = await enrichProfileFromText(url, text);
    if (!enriched) {
      return NextResponse.json(
        { error: "Claude did not return parseable JSON" },
        { status: 502 }
      );
    }
    console.log("[api/profiles/enrich] done", url);
    return NextResponse.json({ data: enriched });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Enrichment failed";
    console.error("[api/profiles/enrich] error", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
