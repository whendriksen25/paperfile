# Document Archive — Project Specs

## What the app does and who uses it

A personal document **archiver and digitiser**. One user (Wim) is the only operator,
but the app understands **multiple profiles** (himself, family members, his LLC) so
documents can be filed per person/entity.

The app is the **single intake point** for every piece of paper Wim accumulates —
receipts, invoices, medical forms, contracts, letters, payslips, IDs, anything. For each
upload it:

1. Stores the **original** file in Dropbox at a structured path.
2. Runs **Claude** to OCR the content, classify the document type, extract structured
   fields, identify which profile it belongs to, and assign a purchase category when
   the doc is a purchase.
3. Decides whether the document **requires action** — a bill needing payment, a contract
   needing signature, an appointment letter needing a response, a deadline approaching.
   If yes, an **action** row is created and shows up in a to-do list.
4. Keeps the structured metadata in Supabase, fully searchable.

A future phase **may optionally push** the financial subset of documents (invoices,
receipts, bills, payslips) to `bookkeeping-aiuto`'s intake endpoint as a convenience —
so Wim doesn't have to re-upload the same doc into bookkeeping if he already filed it
through the archiver. This push is **opt-in** and **off by default**.

`bookkeeping-aiuto` stays a fully independent app with its own capture flow. It can
still receive invoices uploaded directly into it. The archiver is not bookkeeping's
intake; it's a separate intake Wim happens to prefer for personal use.

## Relationship to bookkeeping-aiuto

```
┌──────────────────┐    optional push (off by default)  ┌──────────────────────┐
│ document-archive │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─▶│  bookkeeping-aiuto   │
│ all docs intake  │       POST /api/upload             │ accounting + own     │
│                  │                                    │ direct intake too    │
└──────────────────┘                                    └──────────────────────┘
```

- Both apps are **fully independent**. Bookkeeping retains its own capture flow and
  receives invoices uploaded directly into it.
- The push from archiver to bookkeeping is an **opt-in convenience** for when Wim
  files a financial doc through the archiver and doesn't want to re-upload it.
- Two **separate codebases**, Vercel projects, Supabase projects, Dropbox folders.
- Each has its own `core.profiles` table. Profile `name` is the join key when the
  archiver pushes to bookkeeping (best-effort string match; user reconciles in
  bookkeeping if needed).
- Bookkeeping does not read the archiver's database. The archiver does not depend on
  bookkeeping's schema.

## Tech stack

- **Language:** TypeScript
- **Framework:** Next.js 14 (App Router)
- **Auth/DB:** Supabase Pro — project `document-archive` (`rwowrsiwysergszkenqf`)
- **File storage:** Dropbox (user's existing 3 TB account)
- **AI:** Claude Sonnet for OCR, classification, action detection, field extraction
- **Styling:** Tailwind CSS, dark premium theme
- **Deployment:** Vercel
- **PWA:** installable on iOS/Android home screen; iOS Shortcut for Share Sheet upload
- **Dev port:** 3002 (bookkeeping-aiuto uses 3001)

## Pages and user flows

### Public (unauthenticated)
- `/login`, `/register`, `/reset-password` — present but bypassed when
  `DEV_AUTO_LOGIN=true`. They exist for when real auth is re-enabled.

### Authenticated
- `/upload` — mobile-first upload screen. Camera capture, multi-file picker, optional
  profile selector (defaults to active profile), optional batch name, optional tags.
- `/inbox` — newest-first list of all documents. Filter chips for profile, type,
  status, batch.
- `/document/[id]` — detail view of one document. Original (rendered from Dropbox
  signed link), extracted fields, OCR text, tags, batch, related action (if any),
  manual edit, delete.
- `/actions` — open actions across all profiles. Status: `open`, `done`, `dismissed`.
  Sort: by `due_date` first.
- `/search` — full-text search across OCR text + metadata; filters for type, date
  range, sender, profile, purchase category, batch, tags.
- `/batches` — list of named batches; tap to open the batch's documents.
- `/profiles` — list, create, edit, delete profiles. Each profile has a name, type
  (`person`, `business`), and a colour for visual identification.
- `/settings` — Dropbox connection status, Claude connection status, dev-login state,
  iOS Shortcut token.

### API routes
- `POST /api/upload` — accepts a file, uploads to Dropbox, inserts pending row, kicks
  off extraction.
- `POST /api/analyze/[id]` — runs Claude extraction; updates row; inserts an action if
  `needs_action=true`.
- `GET /api/documents` — list with filters (type, date, profile, batch, etc.).
- `GET /api/documents/[id]` — single document detail.
- `PATCH /api/documents/[id]` — edit extracted fields, profile, tags, batch, status.
- `DELETE /api/documents/[id]` — soft-delete (does NOT remove from Dropbox).
- `GET /api/documents/[id]/file` — returns a time-limited Dropbox link.
- `GET /api/actions` — list open actions, optionally filtered by profile.
- `PATCH /api/actions/[id]` — mark done, dismiss, snooze, edit notes.
- `GET /api/profiles` — list profiles.
- `POST /api/profiles` — create profile.
- `PATCH /api/profiles/[id]` — edit profile.
- `DELETE /api/profiles/[id]` — delete profile (only if no documents reference it).
- `POST /api/shortcut/upload` — token-authenticated endpoint used by the iOS Shortcut.
- `GET /api/auth/dev-login` — dev auto-login bootstrap (creates dev user + signs in).

## Data model

Two Postgres schemas: `core` (profiles), `archive` (documents, actions, shortcut_tokens).

### `core.profiles`
- `id` (serial pk), `user_id` (uuid → auth.users)
- `name` (text), `type` (text — `person` or `business`)
- `color` (text — for UI), `is_default` (boolean)
- `created_at`

### `archive.documents`
Same as the existing `documents` table plus:
- `primary_profile_id` → `core.profiles(id)` ON DELETE SET NULL
- `purchase_category` (text — free-form, e.g. `food`, `material`, `clothing`,
  `transport`, `health`, etc., set by Claude when relevant; null otherwise)
- `needs_action` (boolean), `action_type` (text — `pay`, `respond`, `sign`,
  `file_with_authority`, `none`), `due_date` (date), `action_summary` (text)

The free-text `person` column is dropped in favour of `primary_profile_id`.

### `archive.actions`
Each `needs_action=true` document spawns an action row:
- `id` (uuid pk), `user_id` (uuid)
- `document_id` (uuid → archive.documents ON DELETE CASCADE)
- `profile_id` (int → core.profiles ON DELETE SET NULL)
- `action_type` (text), `summary` (text), `due_date` (date)
- `status` (text — `open` | `done` | `dismissed` | `snoozed`), `snooze_until` (date)
- `created_at`, `updated_at`

### `archive.shortcut_tokens`
Unchanged — bearer tokens for the iOS Shortcut.

### RLS
Every row scoped by `user_id = auth.uid()` for SELECT, INSERT, UPDATE, DELETE on all
three tables.

## Claude extraction — output schema

The prompt asks Claude to return a single JSON object with:

- `document_type` (one of the canonical types)
- `document_subtype`
- `confidence` (0..1)
- `document_date`, `sender`, `recipient`, `language`
- `profile_hint` — the human name on the document, if any (e.g. "Hendriksen, Wim").
  Server-side this is matched against existing profiles to auto-set `primary_profile_id`.
- `amount`, `currency`
- `purchase_category` (when document is a purchase: food / material / clothing /
  transport / health / housing / utilities / other; otherwise null)
- `title`, `summary`, `tags`, `extracted_fields`
- `ocr_text`
- `needs_action` (boolean)
- `action_type` (one of: `pay`, `respond`, `sign`, `file_with_authority`, `none`)
- `due_date` (the deadline if any)
- `action_summary` (short, like "Pay €234.50 to Mediq by 15 May")

## Third-party services

- **Supabase** — Pro org `Power On Wheels`, project `document-archive`.
- **Anthropic Claude** — Sonnet model.
- **Dropbox** — user-registered app `document-archive`.
- **Vercel** — hosting (later).

## Environment variables (see `.env.local.example`)

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (using new `sb_publishable_*` / `sb_secret_*` format)
- `ANTHROPIC_API_KEY`
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_ACCESS_TOKEN`,
  `DROPBOX_ROOT_FOLDER`
- `NEXT_PUBLIC_APP_URL`
- `SHORTCUT_MASTER_TOKEN`
- `DEV_AUTO_LOGIN`, `DEV_USER_EMAIL`, `DEV_USER_PASSWORD`

## Dropbox folder structure

Originals live in Dropbox under `DROPBOX_ROOT_FOLDER` (default `/Archive`). Two-step
flow: stage in `_inbox`, then move to a structured path after Claude classifies.

**Step 1 — initial upload (instant, before Claude runs):**
```
/Archive/_inbox/{timestamp}_{filename}
```

**Step 2 — after classification:**
```
/Archive/{profile_slug}/{YYYY}/{document_type}/{timestamp}_{filename}
```

`profile_slug` = sanitised name of the document's profile (e.g. `Wim`, `Father`,
`Wim_LLC`). `document_type` is the Claude-classified type (e.g. `medical_bill`,
`receipt`, `contract`). The timestamp prefix prevents collisions when two files share
the same name.

**Examples:**
```
/Archive/Father/2024/medical_bill/1745234567890_dr_jansen_invoice.pdf
/Archive/Wim/2026/receipt/1745234567890_office_supplies.pdf
/Archive/Wim_LLC/2026/invoice/1745234567890_supplier_april.pdf
```

**Why this layout:**
- **Profile first** so Wim can share one person's folder via Dropbox if needed (e.g.
  give Father access to `/Archive/Father/` only).
- **Year second** so each profile's archive is easy to scan and archive annually.
- **Type third** groups related docs naturally inside a year.
- **`_inbox/` underscore prefix** sorts to the top in Dropbox so unprocessed or
  unclassifiable documents are visible at a glance — it doubles as a "needs review" pile.

If classification fails or confidence is below a threshold, the file stays in
`_inbox/` and is flagged `needs_review=true` in the database for manual handling.

## iOS Shortcut integration

A one-tap iOS Shortcut posts files from the iOS Share Sheet to
`/api/shortcut/upload` with a bearer token. Server creates a document row owned by the
single user, returns success.

## PWA

- `manifest.json`, dark theme color, standalone display mode, "Add to Home Screen" on
  iOS Safari, install prompt on Android Chrome.
- Basic service worker. Not offline-first — uploads need network.

## Bookkeeping handoff (implemented)

- This is a **convenience for Wim** when he wants the archiver to forward a financial
  doc to bookkeeping. It's not a required pipeline; both apps stay independent.
- Behaviour: after successful extraction, if `document_type IN ('invoice', 'receipt',
  'bill', 'payslip', 'bank_statement')`, a `send_to_bookkeeping` action appears in the
  Action Center (and a "Re-send" button on the document page). Tapping it calls
  `POST /api/documents/[id]/send-to-bookkeeping`.
- What gets sent: **JSON only, never the file binary.** The payload contains all
  extracted metadata (type, date, sender, amounts, tags, extracted_fields, OCR text),
  the Dropbox path + a temporary download link, and the paperfile doc id. Bookkeeping
  stores the Dropbox location and fetches the original from Dropbox when it needs to
  display it — one canonical file, no second copy.
- Bank statements additionally include **every parsed transaction row** (paged fetch
  in batches of 1000 — statements over 1000 rows are sent complete, not truncated).
  The receiver books per-transaction without re-parsing the statement.
- The receiver (`bookkeeping-aiuto /api/external/paperfile-import`, authenticated via
  the shared `x-paperfile-token`) dedupes by paperfile doc id and per-transaction
  fingerprint, then classifies transactions to profiles. For large statements the
  receiver may not finish classification in one request; this route then drains the
  backlog with follow-up calls to `POST {bookkeeping}/api/bank-statements/classify`
  (max 6 × 30s budget) so transactions arrive classified without user action.
- Route timeout is `maxDuration = 300`. The push response records imported /
  skipped-duplicate / classification counts and is surfaced to the UI.
- On success the doc gets `sent_to_bookkeeping_at`, `bookkeeping_doc_id`,
  `bookkeeping_url`, and any open `send_to_bookkeeping` action is closed.
- Settings (Settings page → Bookkeeping handoff): bookkeeping base URL + shared
  secret. Sent as `x-paperfile-token`; must equal `PAPERFILE_INBOUND_TOKEN` in the
  bookkeeping app's environment.
- Still future / not built: per-profile "auto-send after extraction" toggle, and the
  `handoff_status` column bookkeeping-ack flow.

## What "done" looks like for v1

- [ ] User auto-signs in via `/api/auth/dev-login` (or via real auth when
      `DEV_AUTO_LOGIN=false`).
- [ ] User can upload single or multiple files.
- [ ] Each upload lands first in `/Archive/_inbox/`, then is moved after classification
      to `/Archive/{profile}/{YYYY}/{document_type}/{filename}`.
- [ ] Claude extracts type, date, sender, amount, summary, tags, purchase category,
      OCR text, AND identifies whether action is needed.
- [ ] Documents that need action automatically appear in `/actions`.
- [ ] User can manage profiles in `/profiles`. Each document can be assigned to a
      profile.
- [ ] Inbox lists newest first with a profile chip per row.
- [ ] Full-text search returns matching documents.
- [ ] Tags + batches + profile + category filters all work.
- [ ] User can install the PWA on iPhone home screen.
- [ ] iOS Shortcut uploads via Share Sheet.
- [ ] All of the above works on the deployed Vercel URL, not just localhost.

## Paperfile Assistant (global AI chat) — implemented

Code: `lib/ai/assistant-tools.ts` (tool schemas + read executors + proposal
previews), `app/api/assistant/route.ts` (Claude tool-use loop),
`app/api/assistant/execute/route.ts` (confirmed proposals; mutations reuse
the existing API routes via internal fetch with forwarded cookies, so
re-filing, action updates, bookkeeping pushes and re-analysis behave exactly
like their UI buttons), `components/assistant/assistant-chat.tsx` (floating
chat panel, mounted in the app layout).

A floating chat button (bottom-right, every page — same pattern as Aiuto's
Booking Assistant) opening a panel where Wim can ask anything about his
archive. Claude tool-use agent, three layers, mirroring the proven Aiuto
assistant architecture:

**1. Find & explain (read-only, no confirmation).** The primary use case.
Tools:
- `search_documents` — full-text search over title, summary, sender, tags
  and OCR text; filters for profile, document type, date range. Returns top
  matches with links.
- `get_document` — full details of one document (extracted fields, actions,
  filing location, bookkeeping status).
- `list_actions` — open/done actions, filterable by profile and document.
Typical questions: "where is my insurance policy from 2024?", "which CJIB
fines are still open?", "what did I file under Pa last month?"

**2. Act on instruction (confirm-first).** The agent can do what the user
asks, but every mutation is returned as a PROPOSAL the user must confirm in
the chat before the server executes it (POST `/api/assistant/execute`):
- `refile_document` — change profile / document type, triggers re-filing.
- `create_action` / `complete_action` / `dismiss_action` — manage the
  Action Center.
- `send_to_bookkeeping` — trigger the Aiutofin push for a document.
- `reanalyze_document` — re-run AI extraction.

**3. Navigate.** A `navigate` directive the panel uses to route the user to
the right page (document page, filtered inbox, actions search) so the items
under discussion are on screen.

Implementation notes: endpoint `POST /api/assistant` (Claude Sonnet,
tool-use loop, short client-held history), tool executors in
`lib/ai/assistant-tools.ts`, all queries scoped to the session user.
Search backed by Postgres `ilike`/full-text over documents incl. `ocr_text`.

Done when: `npm run build` passes; "where is my insurance policy from
2024?" answers with correct linked documents; a refile and an action
completion both work end-to-end via chat confirmation; a document can be
pushed to bookkeeping from the chat.

## Direct-to-Dropbox upload (large / multipage files) — SPEC, pending approval [2026-07-01 16:27:50 CEST]

### Problem
The upload routes (`/api/upload`, `/api/shortcut/upload`) are Vercel serverless
functions. The file travels inside the request body, which Vercel caps at ~4.5 MB and
rejects at the edge (HTTP 413) **before our code runs**. Multipage scans and any file
over ~4.5 MB fail silently — no `documents` row, no log. (The `bodySizeLimit: "25mb"`
in `next.config.mjs` only applies to Next.js Server Actions, not these Route Handlers,
so it does not help here.)

### Goal
Let large / multipage documents upload successfully by keeping the file bytes **off**
the Vercel function path. Analysis, filing, action detection and categorisation stay
exactly as they are today.

### New flow (web / PWA path)
1. **On device:** compress images (as today); in combine mode stitch the pages into a
   single PDF **in the browser** (`pdf-lib`, client-side) and compute a SHA-256 hash
   via `crypto.subtle`.
2. `POST /api/upload/dropbox-link` (new) — authenticates the user; server asks Dropbox
   for a one-time upload URL (`filesGetTemporaryUploadLink`) for the
   `_inbox/{timestamp}_{filename}` path and returns `{ uploadUrl, path }`. The Dropbox
   token never leaves the server.
3. **Client PUTs the file bytes directly to `uploadUrl`** — this request goes to
   Dropbox, not Vercel, so the 4.5 MB limit never applies (temp-link cap is 150 MB per
   file).
4. `POST /api/upload/finalize` (new) — authenticates the user; verifies the file exists
   in Dropbox (reads metadata for the authoritative size); runs the same SHA-256 dedup
   check; inserts the `documents` row (`status: pending`); triggers `/api/analyze/[id]`
   and the periodic sanity check — identical to what `/api/upload` does today.

### Processing (unchanged)
`/api/analyze/[id]` already downloads the file back **from** Dropbox and runs
OCR / classification / profile match / actions / reconciliation. Nothing about it
changes. (Claude's own per-request limits — roughly ~32 MB / ~100 pages per PDF —
remain the practical ceiling for the AI read; the existing `ai_truncated` flag +
"Retry full" path already handle that.)

### Files
- **New:** `app/api/upload/dropbox-link/route.ts`, `app/api/upload/finalize/route.ts`,
  `lib/utils/combine-images-client.ts` (browser-side PDF stitch, JPEG input).
- **Changed:** `lib/dropbox/upload.ts` + `lib/storage/types.ts` +
  `lib/storage/dropbox-adapter.ts` — add `getTemporaryUploadLink()`.
  `components/upload/upload-form.tsx` — `submit()` reworked to
  link → direct-PUT → finalize (single + combine modes), client-side SHA-256.
- **Kept intact (backward compatibility):** `app/api/upload/route.ts` — still works for
  small files and as a fallback; nothing removed.

### Out of scope for this change
- The iOS Shortcut endpoint (`/api/shortcut/upload`) still routes bytes through Vercel,
  so it keeps the 4.5 MB limit. Separate follow-up if large Shortcut uploads are needed.
- Files over 150 MB (would need server-proxied chunked upload sessions). Not needed for
  documents — largest ever stored is 2.4 MB.

### Rollout & safety
- Feature branch off `main`; `npm run build` clean; local smoke test at `localhost:3002`.
- Deploy a Vercel **Preview** (its own URL, separate from production); test a real
  multipage upload from the phone. **Production stays untouched.**
- Merge to `main` only after the preview is verified. Rollback = Vercel Deployments →
  promote the previous deploy (the change is additive and the old `/api/upload` is
  untouched, so revert is clean).

### Done when
- `npm run build` passes with no console errors.
- A >4.5 MB multipage PDF uploads from the phone via the web app on the Preview deploy,
  lands in Dropbox, gets a `documents` row, and is fully analysed (type, profile,
  actions) end-to-end.
- Existing small single-file uploads still work.

## Out of scope for v1

- Multi-user collaboration, sharing, document-level permissions.
- Editing the original PDF/image.
- Auto-send-to-bookkeeping toggle (manual send per doc IS implemented, see
  "Bookkeeping handoff" above).
- Receipts-to-tax export.
- Calendar integration for action due-dates.

## Project location on disk

This is the canonical local working directory for everything in this app —
codebase, git repo, dev server, all Claude commands:

```
/Users/jean/Documents/Personal/Werk/Software/document-archive
```

All `cd`, `git`, `npm`, `node`, `npx`, and curl commands run from inside this
folder. The git remote is `https://github.com/whendriksen25/paperfile.git`
(branch `main`).

The sibling folder `bookkeeping-aiuto/` is a **different app** with its own repo
and is not touched by Paperfile changes. Don't push Paperfile commits from the
bookkeeping-aiuto folder, and don't push bookkeeping commits from here.

## Naming

- Project folder: `document-archive`
- Package name: `document-archive`
- Supabase project: `document-archive`
- Dropbox app: `document-archive`
- App title (in UI): `Archive`

## Working log conventions

When Claude runs any command in the chat (bash, git, npm, migrations, dev server, etc.),
it must prefix the command output with the **date and exact local time** the command
ran, formatted as `[YYYY-MM-DD HH:MM:SS TZ]`. Run `date "+%Y-%m-%d %H:%M:%S %Z"` to get
the current time. This makes the chat double as a time-stamped activity log.
