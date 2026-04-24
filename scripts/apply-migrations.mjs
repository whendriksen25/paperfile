// Apply all SQL migration files in /supabase/migrations to the Supabase Postgres DB.
// Run from the document-archive folder:
//   node scripts/apply-migrations.mjs
//
// The script reads the DB password from ./supabase-db-password.txt and the
// project ref from NEXT_PUBLIC_SUPABASE_URL in .env.local.

import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");

// 1. Password — from file or env
let password = process.env.SUPABASE_DB_PASSWORD;
if (!password) {
  const pwFile = path.join(ROOT, "supabase-db-password.txt");
  if (existsSync(pwFile)) {
    const match = readFileSync(pwFile, "utf8").match(/Password:\s*(\S+)/);
    password = match?.[1];
  }
}
if (!password) {
  console.error(
    "Could not find DB password. Expected either SUPABASE_DB_PASSWORD env var or 'Password: xxx' in supabase-db-password.txt"
  );
  process.exit(1);
}

// 2. Project ref — from .env.local
let projectRef = process.env.SUPABASE_PROJECT_REF;
if (!projectRef) {
  const envFile = path.join(ROOT, ".env.local");
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, "utf8").match(
      /NEXT_PUBLIC_SUPABASE_URL=https:\/\/([a-z0-9]+)\.supabase\.co/
    );
    projectRef = match?.[1];
  }
}
if (!projectRef) {
  console.error("Could not find Supabase project ref in .env.local");
  process.exit(1);
}

console.log(`[migrations] project ref: ${projectRef}`);

// Try direct connection first, fall back to pooler if DNS fails
const directConfig = {
  host: `db.${projectRef}.supabase.co`,
  port: 5432,
  user: "postgres",
  password,
  database: "postgres",
  ssl: { rejectUnauthorized: false },
};

// Supabase's shared pooler — covers both eu-central-1 and eu-west-1
const poolerConfigs = [
  { region: "eu-central-1" },
  { region: "eu-west-1" },
  { region: "eu-west-2" },
].map((r) => ({
  host: `aws-0-${r.region}.pooler.supabase.com`,
  port: 5432,
  user: `postgres.${projectRef}`,
  password,
  database: "postgres",
  ssl: { rejectUnauthorized: false },
}));

async function tryConnect(config) {
  const client = new pg.Client(config);
  await client.connect();
  return client;
}

async function connect() {
  try {
    console.log(`[migrations] trying direct: ${directConfig.host}`);
    return await tryConnect(directConfig);
  } catch (e) {
    console.log(`[migrations] direct failed (${e.code || e.message}), trying poolers...`);
  }
  for (const cfg of poolerConfigs) {
    try {
      console.log(`[migrations] trying pooler: ${cfg.host}`);
      return await tryConnect(cfg);
    } catch (e) {
      console.log(`[migrations] ${cfg.host} failed (${e.code || e.message})`);
    }
  }
  throw new Error("Could not connect to any Supabase host");
}

async function main() {
  const client = await connect();
  console.log("[migrations] connected");

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    console.log(`[migrations] applying ${file}`);
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      await client.query(sql);
      console.log(`[migrations] done: ${file}`);
    } catch (e) {
      // If the table already exists, treat as idempotent
      if (e.message?.includes("already exists")) {
        console.log(`[migrations] already applied: ${file}`);
        continue;
      }
      console.error(`[migrations] failed: ${file}`);
      console.error(e.message);
      throw e;
    }
  }

  // Force PostgREST to refresh its schema cache so newly added columns
  // are immediately visible via the REST/Auth API. Without this, you can
  // get "Could not find the 'X' column of 'Y' in the schema cache" errors.
  try {
    await client.query("NOTIFY pgrst, 'reload schema';");
    console.log("[migrations] PostgREST schema cache reload requested");
  } catch (e) {
    console.warn("[migrations] reload notify failed (non-fatal)", e.message);
  }

  await client.end();
  console.log("[migrations] all done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
