#!/usr/bin/env node
/**
 * Verifies that lib/categories.ts in this repo matches its sibling in
 * ../bookkeeping-aiuto/lib/categories.ts. Run via:
 *
 *     npm run check:categories
 *
 * Fails (exit 1) if the two files differ. Intended to be run locally before
 * pushing — keeps the canonical taxonomy in lock-step between the two apps.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const here = resolve(__dirname, "..", "lib", "categories.ts");
const there = resolve(
  __dirname,
  "..",
  "..",
  "bookkeeping-aiuto",
  "lib",
  "categories.ts"
);

if (!existsSync(there)) {
  console.warn(
    `[check:categories] Skipping — bookkeeping-aiuto not present at ${there}.`
  );
  process.exit(0);
}

const a = readFileSync(here, "utf8");
const b = readFileSync(there, "utf8");

if (a === b) {
  console.log("[check:categories] OK — categories.ts is identical in both repos.");
  process.exit(0);
}

console.error(
  "[check:categories] MISMATCH — lib/categories.ts differs between document-archive and bookkeeping-aiuto."
);
console.error(`  document-archive: ${here}`);
console.error(`  bookkeeping-aiuto: ${there}`);
console.error(
  "  Fix by copying the authoritative version into the other repo, e.g.:"
);
console.error(`    cp '${here}' '${there}'`);
process.exit(1);
