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

## Future bookkeeping handoff (out of v1, opt-in, in spec for clarity)

- This is a **convenience for Wim** when he wants the archiver to forward a financial
  doc to bookkeeping. It's not a required pipeline.
- Behaviour: after successful extraction, if `document_type IN ('invoice', 'receipt',
  'bill', 'payslip', 'bank_statement')`, the user is shown a "Send to bookkeeping"
  button on the document detail page. Tapping it POSTs the file + extracted JSON to
  bookkeeping-aiuto's upload endpoint.
- Optionally a per-profile toggle "Auto-send financial docs to bookkeeping" can be
  enabled, in which case the push happens automatically post-extraction.
- Bookkeeping treats it as new intake and runs its own (deeper, accounting-specific)
  extraction.
- The archiver records the handoff in `archive.documents.handoff_status` (`pending`,
  `sent`, `failed`, `acked`, `not_applicable`) — schema column reserved now, code
  added later.

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

## Out of scope for v1

- Multi-user collaboration, sharing, document-level permissions.
- Editing the original PDF/image.
- Bookkeeping handoff (column reserved, push not implemented).
- Bank-statement transaction extraction (already covered by bookkeeping-aiuto).
- Receipts-to-tax export.
- Calendar integration for action due-dates.

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
