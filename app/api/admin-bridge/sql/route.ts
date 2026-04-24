import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readFileSync, existsSync } from "fs";
import path from "path";
import pg from "pg";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Dev-only SQL bridge.
 *
 * Three independent gates must ALL be open. If any fails, 403 Forbidden.
 *   Gate 1: DEV_AUTO_LOGIN === "true" in the server env
 *   Gate 2: NODE_ENV !== "production"
 *   Gate 3: request host is localhost/127.0.0.1/.local
 *
 * On Vercel: NODE_ENV is automatically "production" → Gate 2 blocks every
 * call. DEV_AUTO_LOGIN should also be left unset in the Vercel env.
 */

function getDbPassword(): string | null {
  if (process.env.SUPABASE_DB_PASSWORD) return process.env.SUPABASE_DB_PASSWORD;
  const pwFile = path.resolve(process.cwd(), "supabase-db-password.txt");
  if (existsSync(pwFile)) {
    const match = readFileSync(pwFile, "utf8").match(/Password:\s*(\S+)/);
    if (match) return match[1];
  }
  return null;
}

function getProjectRef(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  const match = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  return match?.[1] || null;
}

function isLocalhostRequest(request: NextRequest): boolean {
  const host = (request.headers.get("host") || "").split(":")[0];
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local")
  );
}

const POOLER_REGIONS = ["eu-central-1", "eu-west-1", "eu-west-2"];

async function connectPg(projectRef: string, password: string): Promise<pg.Client> {
  try {
    const c = new pg.Client({
      host: `db.${projectRef}.supabase.co`,
      port: 5432,
      user: "postgres",
      password,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    return c;
  } catch (e) {
    console.warn("[api/admin-bridge/sql] direct failed", (e as Error).message);
  }
  for (const region of POOLER_REGIONS) {
    try {
      const c = new pg.Client({
        host: `aws-0-${region}.pooler.supabase.com`,
        port: 5432,
        user: `postgres.${projectRef}`,
        password,
        database: "postgres",
        ssl: { rejectUnauthorized: false },
      });
      await c.connect();
      return c;
    } catch (e) {
      console.warn(`[api/admin-bridge/sql] ${region} failed`, (e as Error).message);
    }
  }
  throw new Error("Could not connect to any Supabase Postgres host");
}

export async function POST(request: NextRequest) {
  console.log("[api/admin-bridge/sql] start");

  if (process.env.DEV_AUTO_LOGIN !== "true") {
    return NextResponse.json(
      { error: "Disabled. Only when DEV_AUTO_LOGIN=true." },
      { status: 403 }
    );
  }
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Disabled in production." }, { status: 403 });
  }
  if (!isLocalhostRequest(request)) {
    return NextResponse.json({ error: "Only callable from localhost." }, { status: 403 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const sql = String(body.sql || "").trim();
  if (!sql) return NextResponse.json({ error: "Provide sql" }, { status: 400 });

  const password = getDbPassword();
  const projectRef = getProjectRef();
  if (!password)
    return NextResponse.json(
      { error: "DB password missing (supabase-db-password.txt or SUPABASE_DB_PASSWORD)." },
      { status: 500 }
    );
  if (!projectRef)
    return NextResponse.json(
      { error: "Could not derive project ref from NEXT_PUBLIC_SUPABASE_URL." },
      { status: 500 }
    );

  let client: pg.Client | null = null;
  try {
    client = await connectPg(projectRef, password);
    const result = await client.query(sql);
    if (Array.isArray(result)) {
      return NextResponse.json({
        results: result.map((r) => ({
          command: r.command,
          rowCount: r.rowCount,
          rows: r.rows,
        })),
      });
    }
    return NextResponse.json({
      command: result.command,
      rowCount: result.rowCount,
      rows: result.rows,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "SQL failed";
    console.error("[api/admin-bridge/sql] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
