# login.md — Multi-tenant login playbook (Supabase Auth)

A reusable recipe for adding a working, multi-tenant owner/user login to a
Next.js (App Router) + Supabase project. It encodes the pattern that works **and
the specific mistakes already made in Bridge CRM**, so we don't repeat them.

Drop this file in any project that needs login; follow it top to bottom.

---

## The model

- **Auth:** Supabase Auth via `@supabase/ssr` (cookie-based sessions). No custom
  JWT, no hand-rolled password hashing.
- **Multi-tenant scoping:** every tenant row carries an owner/tenant id. Two
  shapes in use across our projects — pick one:
  - **owner_user_id** on the tenant row (TableStory): a row belongs to the user
    whose `id = auth.uid()`. Simple, good for 1 owner per tenant.
  - **tenant_id** + a `get_user_tenant_id()` helper (Bridge CRM): users belong to
    a tenant; all data rows filter by `tenant_id`. Good for teams.
- **Operator / super-admin:** a small allow-list (env `OPERATOR_EMAILS`) that can
  see everything. Everyone else is scoped to their own tenant.
- **RLS:** keep Row-Level Security ON. The service-role client (server-only)
  bypasses RLS for operator/admin tasks; the anon client respects it.

---

## Files (the working pattern)

```
lib/supabase/server.ts     # serverClient() (cookies) + adminClient() (service role)
lib/supabase/browser.ts    # browserClient() for client components
lib/auth.ts                # getSessionUser(), isOperator(), <scope helper>
middleware.ts              # refresh session on every request + protect routes
app/(area)/login/page.tsx  # client form → POST /api/auth/login → full reload
app/api/auth/login/route.ts    # signInWithPassword (cookies set automatically)
app/api/auth/logout/route.ts   # signOut()
components/logout-button.tsx    # client: POST logout → window.location='/login'
```

Core snippets:

```ts
// login route (server) — cookies are set automatically by @supabase/ssr
const { error } = await serverClient().auth.signInWithPassword({ email, password });

// login page (client) — FULL RELOAD so middleware refreshes cookies
if (res.ok) window.location.href = "/dashboard";

// auth check — getUser() RE-VALIDATES the token; never trust getSession()
const { data: { user } } = await supabase.auth.getUser();

// middleware — refresh session before route handlers run, then gate routes
const requireLogin = process.env.NEXT_PUBLIC_REQUIRE_OWNER_LOGIN === "true";
if (requireLogin && isProtected(path) && !user) return redirect("/login");
```

---

## Lessons baked in (mistakes from Bridge CRM — do NOT repeat)

1. **Full-page reload after login/signup.** Use `window.location.href`, not
   `router.push()`. A client-side push doesn't wait for auth cookies to be set;
   the middleware hasn't run yet → redirect loops / "logged in but bounced".
2. **Refresh the session in middleware.** Cookie writes from a Server Component
   silently fail (response already streaming). Middleware runs first, so refresh
   the token there. Keep the `setAll` try/catch in `server.ts` with the comment
   "ignored — middleware refreshes the session".
3. **`getUser()` not `getSession()`.** `getSession()` trusts the cookie blindly;
   `getUser()` re-validates with Supabase. Use it for any auth gate.
4. **Service-role key is server-only.** Import `adminClient()` ONLY in API routes
   / server code (signup, admin ops). Never in a client component — it must never
   reach the browser.
5. **Redirect order in middleware:** (1) not logged in → /login; (2) logged in
   but rejected → /login; (3) logged in but pending → /pending-approval; (4) else
   allow. Check login state BEFORE status.
6. **Centralize role checks.** One `isOperator()` / admin-gate helper, not
   scattered `if email === ...` in every route. Use a feature flag for staged
   rollout (operator now, owners later).
7. **NOT NULL columns on live tables in 3 steps:** ADD COLUMN with default →
   UPDATE existing rows → SET NOT NULL. Never one-shot.
8. **Forgot-password checks Supabase Auth**, not just your profile table, before
   claiming "reset link sent".
9. **Cookies & custom domains:** when moving from localhost to a custom domain,
   set the domain in Supabase → Authentication → URL Configuration (Site URL +
   redirect URLs), and make sure the app is served from that exact origin.
10. **Transactional email from a verified domain** (Resend/SendGrid), not the
    provider's test sender, or deliverability tanks.

---

## Env vars

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # server-only
OPERATOR_EMAILS=you@example.com   # comma-separated super-admins
NEXT_PUBLIC_REQUIRE_OWNER_LOGIN=false   # flip to true once accounts exist
```

Also in Supabase → Authentication → URL Configuration: add the app's Site URL and
redirect URLs (localhost AND production domain).

---

## Bootstrap (turning login on safely)

1. Build the files above with enforcement **off** (`...REQUIRE_OWNER_LOGIN=false`)
   so nobody is locked out before accounts exist.
2. Create the first account: Supabase dashboard → Authentication → Users → Add
   user (email + password). (The agent must not create accounts/passwords — a
   human does this step.)
3. Link the account to its tenant:
   ```sql
   update public.<tenant_table>
   set owner_user_id = '<auth-user-id>'   -- or insert a users row with tenant_id
   where slug = '<tenant-slug>';
   ```
4. Add yourself to `OPERATOR_EMAILS`.
5. Set `NEXT_PUBLIC_REQUIRE_OWNER_LOGIN=true` (locally + in Vercel) and redeploy.
6. Verify: logged-out → redirected to /login; owner sees only their tenant;
   operator sees all; logout returns to /login.

---

## Verify checklist

- [ ] Login sets a session and a full reload lands you in the app.
- [ ] Protected routes redirect to /login when logged out (enforcement on).
- [ ] Owner sees ONLY their tenant's data; operator sees all.
- [ ] `getUser()` used for gates; service-role never imported client-side.
- [ ] RLS still ON; anon cannot read other tenants.
- [ ] Works on the production domain (cookies + Supabase URL config).
