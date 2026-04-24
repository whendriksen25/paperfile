# Document Archive

Personal document archive. Upload any paper (receipts, medical forms, contracts, letters), and Claude classifies it, extracts the fields, and keeps it searchable. Originals live in your Dropbox; metadata lives in Supabase.

## Setup

### 1. Install dependencies

```bash
cd document-archive
npm install
```

### 2. Fill in `.env.local`

Copy `.env.local.example` to `.env.local` (done already) and fill in:

**Supabase** — from Supabase dashboard → Project Settings → API:

- `NEXT_PUBLIC_SUPABASE_URL` (pre-filled)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

**Anthropic** — from [console.anthropic.com](https://console.anthropic.com):

- `ANTHROPIC_API_KEY`

**Dropbox** — from [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) → your app:

- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_ACCESS_TOKEN` (generate one with "No expiration" in the app settings)

### 3. Apply the database schema

In Supabase dashboard → SQL Editor, paste the contents of `supabase/migrations/001_initial_schema.sql` and run it.

### 4. Run locally

```bash
npm run dev
```

Open [http://localhost:3002](http://localhost:3002).

## Architecture

- **Next.js 14** (App Router, TypeScript)
- **Supabase** — auth + Postgres (metadata, OCR text, full-text search)
- **Dropbox** — file storage (originals, via the long-lived access token)
- **Claude Sonnet** (Anthropic) — OCR + classification + structured field extraction
- **Tailwind CSS** — dark theme, shadcn-style primitives
- **PWA** — installable on iOS/Android

## Flow

1. User uploads a file (camera / file picker / iOS Share Sheet via Shortcut).
2. `/api/upload` puts the file in Dropbox at `/Archive/{year}/{category}/{filename}` and inserts a `pending` row in `documents`.
3. `/api/analyze/[id]` downloads the file, runs Claude Sonnet vision for OCR + classification, updates the row with extracted fields.
4. The inbox polls / revalidates and shows the processed document.

## iOS Shortcut (Share Sheet)

See `ios-shortcut/README.md` for the Shortcut recipe and install instructions.

## Deployment (Vercel)

1. Push to GitHub.
2. Import in Vercel, set all env vars.
3. Set the production `NEXT_PUBLIC_APP_URL` to the deployed URL.
