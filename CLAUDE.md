# Project Overview

Personal document archiver. Upload **any** paper or digital document — receipts, invoices,
medical forms, contracts, letters, IDs, payslips, anything — and the app:

1. Stores the original in Dropbox.
2. Uses Claude to OCR + classify + extract structured fields.
3. Tags the document to a **profile** (Wim, Father, Wife, LLC, etc.) and a **purchase
   category** when relevant (food, material, clothing, etc.).
4. Detects whether the document **requires action** (pay this bill, sign this contract,
   respond by this date) and creates an action item.
5. Optionally pushes the financial subset (invoices, receipts, bills, payslips) to
   `bookkeeping-aiuto` for accounting — but only as a convenience.

`bookkeeping-aiuto` stays **fully independent** with its own capture flow, its own
intake, and its own Supabase project. The archiver is Wim's preferred everyday intake;
bookkeeping retains the ability to receive invoices directly. Push from archiver to
bookkeeping is an optional convenience added later, not a coupling.

---

# Relationship to bookkeeping-aiuto

```
┌──────────────────┐    optional push (later, opt-in)  ┌──────────────────────┐
│ document-archive │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶│  bookkeeping-aiuto   │
│ all docs intake  │       POST /api/upload            │ accounting + own     │
│                  │                                   │ direct intake too    │
└──────────────────┘                                   └──────────────────────┘
       │                                                       │
       │                                                       │
       ▼                                                       ▼
   Dropbox /Archive                                       Supabase (own
   + Supabase                                             project, untouched)
```

- Bookkeeping is not downstream of anything. Wim can still upload invoices directly
  into bookkeeping's existing capture flow. Both apps work standalone.
- The "push from archiver" path is an optional convenience for when Wim uploads a
  financial doc to the archiver and wants it forwarded to bookkeeping without
  re-uploading. Off by default.
- Two separate Vercel deployments, two Supabase projects, two Dropbox folders.
- The `core.profiles` concept exists in both, each app owns its copy.

---

# Permissions

**Claude has full access to this project directory.** Execute all commands (bash, npm, node,
curl, file read/write/edit/delete, git, etc.) in
`/Users/jean/Documents/Personal/Werk/Software/document-archive` without asking. Also
allowed: commands targeting `localhost:3002` (dev server port).

---

# Design

Senior UI designer + frontend developer. Premium, dark-themed interfaces. Subtle
animations, proper spacing, visual hierarchy. No emoji icons. No inline styles. No
generic gradients.

---

# Development Rules

**Rule 1: Always read first**
Before any action, read `CLAUDE.md` and `project_specs.md`. If either is missing, create
it first.

**Rule 2: Define before you build**
Update `project_specs.md` before writing code. Show it, wait for approval. No code
before approval.

**Rule 3: Look before you create**
Look at existing files first. Ask if anything is unclear.

**Rule 4: Test before you respond**
After code changes, run the dev server or relevant tests. Never say "done" if untested.

**Core Rule**
Do exactly what's asked. Nothing more, nothing less.

---

# How to Respond

Explain like talking to a 15 year old with no coding background. Every response includes:
- **What I just did** — plain English
- **What you need to do** — step by step
- **Why** — one sentence
- **Next step** — one clear action
- **Errors** — simple explanation + exact fix

For external tools (Supabase, Vercel, Dropbox, etc.): walk through where to find things,
describe each key/setting in one plain sentence. Concise. Less is more.

---

# Time-stamping (always)

Every time Claude **adds** something — a file, a code change, a migration, a script,
a commit instruction, a chat reply that lays out work to be deployed — Claude
prefixes a timestamp so the chat doubles as a dated activity log.

Format: `[YYYY-MM-DD HH:MM:SS TZ]`, e.g. `[2026-05-12 14:32:10 CEST]`.

How Claude gets the current time:

```
date "+%Y-%m-%d %H:%M:%S %Z"
```

When the timestamp goes in:
- At the top of the response when a new file/change is added.
- At the top of every Bash command Claude runs (already enforced by
  `project_specs.md`'s working-log convention).
- In commit messages when handy (not required — git already timestamps).

Skip the timestamp only for pure-conversation replies (no file edits, no
commands, no work being shipped).

---

# Tech Stack

- **Language:** TypeScript
- **Framework:** Next.js 14 (App Router)
- **Backend:** Supabase (Auth, Postgres, RLS) — project `document-archive`
- **File storage:** Dropbox (user's personal account)
- **AI:** Anthropic Claude Sonnet (OCR, classification, action detection, field extraction)
- **Deployment:** Vercel
- **Styling:** Tailwind CSS
- **Key libraries:** `@supabase/supabase-js`, `@supabase/ssr`, `@anthropic-ai/sdk`, `dropbox`, `pg`
- **Dev port:** 3002

---

# Running the Project

1. Ensure `.env.local` has all necessary keys (see `.env.local.example`).
2. `npm install`
3. `npm run migrate` — applies SQL migrations to the Supabase DB.
4. `npm run dev`
5. Open `http://localhost:3002`

`DEV_AUTO_LOGIN=true` in `.env.local` skips the login screen and uses a single dev user.
Flip to `false` to re-enable real auth.

---

# File Structure

- `/app` — user-facing pages
  - `/app/(auth)/` — login, register, reset-password (kept for when DEV_AUTO_LOGIN=false)
  - `/app/(app)/` — authenticated app pages
    - `/upload` — capture from camera, file picker, or Share Sheet
    - `/inbox` — newest-first list of all documents
    - `/document/[id]` — detail view of a single document
    - `/actions` — to-do list of documents that need action
    - `/search` — full-text + filter search
    - `/batches` — review documents grouped by an upload batch label
    - `/profiles` — manage profiles (Wim, Father, Wife, LLC, etc.)
    - `/settings` — connections (Dropbox, Anthropic), dev-login state
- `/app/api/` — server endpoints (upload, analyze, documents CRUD, actions CRUD,
  shortcut/upload, auth/dev-login)
- `/components/` — reusable components
  - `/ui/` — shadcn primitives (button, input, card, badge, spinner)
  - `/layout/` — app-shell, sidebar, mobile nav, profile-selector
  - `/upload/` — camera capture, file picker, upload-form
  - `/inbox/` — document-card, filter-bar
  - `/document/` — detail view, extraction-review
  - `/actions/` — action-card, action-list
  - `/profiles/` — profile-list, profile-form
- `/lib/` — shared helpers
  - `/supabase/` — client, server, middleware
  - `/ai/` — Claude extraction (`extract-document.ts`) + prompts
  - `/dropbox/` — Dropbox client, upload, share-link helpers
  - `/utils/` — formatting, parsing
- `/types/` — TypeScript types (document, action, profile)
- `/hooks/` — React hooks
- `/supabase/migrations/` — SQL migrations
- `/scripts/` — `apply-migrations.mjs` and any future maintenance scripts
- `/public/` — static assets, PWA manifest, icons
- `/ios-shortcut/` — iOS Shortcut recipe + install link

**Code organisation rules:**
- API routes thin — call a lib function, don't put business logic in the route handler.
- One component per file; co-locate page-specific components with the page.
- Supabase server client for server components and API routes; browser client only in
  client components.
- Don't create new top-level folders without asking.

---

# How the App Is Built

1. User uploads a file (camera / file picker / iOS Share Sheet, optionally with a profile
   + batch + tags).
2. Route receives it, uploads to Dropbox at `/Archive/_inbox/{timestamp}_{filename}`,
   inserts metadata row (status `pending`).
3. Route returns immediately. A background call kicks off Claude extraction.
4. Claude extraction updates the row with type, date, sender, summary, OCR text, tags,
   `purchase_category`, `needs_action`, `action_type`, `due_date`, `action_summary` —
   status `processed`.
5. The file is then **moved** in Dropbox from `_inbox` to its final path:
   `/Archive/{profile}/{year}/{document_type}/{filename}`. The `dropbox_path` column
   is updated to point at the new location.
6. If `needs_action=true`, a row is also inserted into `actions` so it shows up in the
   `/actions` to-do list.
7. UI polls or subscribes to realtime updates and shows extraction once ready.
8. (Optional, off by default) If `document_type` is financial, the user can choose to
   POST the doc to `bookkeeping-aiuto`'s upload endpoint.
9. If classification fails or confidence is low, the file stays in `_inbox/` until
   manually resolved — `_inbox/` doubles as a "needs review" pile.
10. If anything fails: clear error, never silent break.

---

# How to Write Code

- Simple, readable code. Clarity > cleverness.
- One change at a time. Don't touch unrelated code.
- Don't over-engineer.
- `console.log` at the start and end of each API route.

---

# Supabase Rules

- Always use RLS. Never disable it.
- Server-side client for all sensitive operations.
- Never expose `service_role` key in client code.
- File storage is Dropbox, not Supabase Storage.
- Schemas: `core` (profiles), `archive` (documents, actions, shortcut_tokens).

---

# Secrets & Safety

- Never hardcode keys.
- Never commit `.env.local`.
- Never expose `service_role` key, Dropbox secret, or Dropbox access token in frontend
  code.
- Ask before deleting or renaming important files.

---

# Testing

Before "done":
- `npm run build` with no errors.
- Dev server runs clean, no console errors.
- Manually test the feature in the browser.
- Confirm existing features still work.

Never say "done" if build fails, console has errors, or the feature hasn't been tested in
the browser.

---

# Scope

Only build what's in `project_specs.md`. Ask before scope changes.
---

# Command Logging

Keep an append-only running log of everything you do in this project at
**`./.claude-log.md`** in the project root. The file is committed to git so
the history stays visible in VS Code (open it as a pinned tab at the start
of every session) and is recoverable across machines.

Every entry MUST:

- Begin with an ISO‑8601 timestamp accurate to the second, with the local
  timezone offset, e.g. `2026-06-05T19:41:23+02:00`. Use `date -Iseconds`
  (Linux/macOS) or the equivalent in your shell to generate it — never
  fabricate the time.
- Be one short line per command, in plain English, with the actual shell
  command (or file path being edited, or API endpoint being called) in
  backticks. Multi-line commands collapse to a single backticked entry.
- Append to the bottom of the file. NEVER rewrite or delete earlier
  entries — if something was wrong, log a correction, don't edit the past.

Cover EVERY action you take in this project:

- Shell commands (`bash`, `npm`, `node`, `git`, `curl`, …) — including any
  run from inside the VS Code integrated terminal.
- File writes / edits / deletes (path + a one-clause "why").
- Git operations (`add`, `commit`, `push`, branch ops, merges).
- External service calls (Supabase RPC/admin ops, Vercel deploys, Stripe,
  Anthropic API, Dropbox, etc.).
- Database migrations or direct SQL runs.

Flush the log before responding at the end of every turn so the file in
VS Code is always up to date with what just happened.

If `.claude-log.md` doesn't exist yet, create it with this two-line header
and start logging from there:

```
# Claude session log

```

Format example:

```
2026-06-05T19:41:23+02:00 — `npm install csv-parse` — added Rabobank credit-card CSV parser dependency
2026-06-05T19:41:55+02:00 — edited `lib/utils/rabobank-csv-parser.ts` — new looksLikeRabobankCreditCardCsv detector + parseRabobankCreditCardCsv function
2026-06-05T19:42:08+02:00 — `git commit -m "Rabobank credit-card CSV fast-path"`
```
