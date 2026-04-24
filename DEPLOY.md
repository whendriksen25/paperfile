# Deploying Paperfile to Vercel

A one-time setup. After this, `git push` = deploy.

## Before you start — quick checks

- `.env.local` is filled in ✅
- Supabase schema applied ✅
- Local app works at `localhost:3002` ✅

## 1. Initialise git + first commit (1 min)

Open Terminal on your Mac:

```bash
cd /Users/jean/Documents/Personal/Werk/Software/document-archive

# init (idempotent — safe even if you've run it before)
git init -b main
git config user.email "whendriksen25@gmail.com"
git config user.name "Wim Hendriksen"

# sanity: make sure .env.local and supabase-db-password.txt are NOT staged
git add -A
git status | grep -E "\.env\.local$|supabase-db-password" && echo "STOP: secrets staged!" || echo "OK secrets are ignored"

git commit -m "Initial Paperfile commit"
```

If the sanity check says **STOP: secrets staged!** do NOT commit — tell me and I'll fix the gitignore.

## 2. Create the GitHub repo (30 sec)

Go to [github.com/new](https://github.com/new):

- **Repository name:** `paperfile` (or whatever you like)
- **Private** (recommended)
- Do NOT initialize with README/gitignore/license
- Click **Create repository**

GitHub shows commands. Copy the repo URL it shows (something like `https://github.com/yourname/paperfile.git`).

## 3. Push (30 sec)

Back in Terminal:

```bash
git remote add origin https://github.com/YOURNAME/paperfile.git
git push -u origin main
```

GitHub will ask to authenticate. Easiest: if you don't have the `gh` CLI configured, GitHub will open a browser prompt and you approve.

## 4. Connect Vercel (2 min)

Go to [vercel.com/new](https://vercel.com/new). Sign in with GitHub if not already.

- Find `paperfile` in the list → click **Import**
- **Framework Preset:** Next.js (auto-detected)
- **Root Directory:** `/` (default)
- **Build/Install/Output Commands:** leave defaults

Expand **Environment Variables** and paste these 10 (name → value — copy values from your `.env.local`):

| Name | Notes |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | already known |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_...` |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_...` — server-side only |
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `DROPBOX_APP_KEY` | |
| `DROPBOX_APP_SECRET` | |
| `DROPBOX_ACCESS_TOKEN` | `sl.u....` |
| `DROPBOX_ROOT_FOLDER` | `/Archive` |
| `SHORTCUT_MASTER_TOKEN` | random string already in .env.local |
| `DEFAULT_STORAGE_PROVIDER` | `dropbox` |

**DO NOT add** `DEV_AUTO_LOGIN`, `DEV_USER_EMAIL`, `DEV_USER_PASSWORD`, or `SUPABASE_DB_PASSWORD` — those are local-dev-only. Production uses real auth.

Leave `NEXT_PUBLIC_APP_URL` out for now — we'll set it in step 6.

Click **Deploy**.

## 5. Wait for the build (~2 min)

Vercel builds and deploys. You get a URL like `https://paperfile-abc123.vercel.app`.

## 6. Set `NEXT_PUBLIC_APP_URL` + redeploy (30 sec)

In the Vercel project:

- **Settings → Environment Variables → Add**
- Name: `NEXT_PUBLIC_APP_URL`
- Value: your actual deploy URL, e.g. `https://paperfile-abc123.vercel.app`
- Environments: ✅ Production, ✅ Preview, ✅ Development
- **Deployments** tab → latest deploy → three-dot menu → **Redeploy** (uncheck "use existing build cache")

## 7. First real login

Production doesn't have `DEV_AUTO_LOGIN` set, so real auth is required:

- Go to `https://paperfile-abc123.vercel.app/register`
- Create your real account (your email + strong password)
- If Supabase emails a confirmation link, click it
- Sign in

You'll land on Upload with an empty archive. Your local dev data doesn't auto-copy (by design — separation between dev + prod users).

## Updates going forward

Every push to `main` redeploys automatically:

```bash
git add -A
git commit -m "Your change"
git push
```

~90 seconds later, production has it.

## Rollbacks

Vercel **Deployments** tab → pick an older one → three-dot → **Promote to Production**. Instant.

## Security notes baked in

- `/api/admin-bridge/sql` has three independent gates — any one failing returns 403. In production, Vercel sets `NODE_ENV=production` which alone blocks every call, regardless of what else is misconfigured.
- The iOS Shortcut endpoint uses `SHORTCUT_MASTER_TOKEN` as a bearer secret — don't share it.
- Dropbox access token, Supabase service_role, Anthropic key are all server-side only.
- RLS on every Supabase table enforces per-user scoping regardless of the service_role code.

## If the build fails

Most likely cause: a missing env var. Vercel will show the error in the build logs. Copy-paste it to me and I'll tell you what to add.
