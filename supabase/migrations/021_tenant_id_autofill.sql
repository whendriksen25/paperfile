-- 021: Auto-fill tenant_id on service-role inserts.
--
-- The multitenant migration gave every tenant table a
-- `tenant_id uuid default get_user_tenant_id()` column plus a
-- `tenant_isolation` RLS policy. That default reads auth.uid() — which is
-- NULL for the service role — so every insert done through the service
-- client (upload/finalize, shortcut upload, analyze child spawns, job
-- workers) produced tenant_id = NULL rows that are INVISIBLE to the user
-- under RLS. First observed as a 404 on /api/documents/:id/file for a
-- direct-Dropbox upload (Fluxa.pdf, 2026-07-01).
--
-- Fix: BEFORE INSERT trigger that derives tenant_id from the row's
-- user_id whenever tenant_id wasn't provided. App code never needs to
-- know about tenants.

create or replace function public.set_tenant_id_from_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.tenant_id is null and new.user_id is not null then
    select tenant_id into new.tenant_id
    from public.users
    where id = new.user_id;
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'documents',
    'actions',
    'analyze_jobs',
    'bank_transactions',
    'line_item_taxonomy',
    'maintenance_log',
    'profiles',
    'reconciliation_jobs',
    'shortcut_tokens',
    'user_settings'
  ] loop
    execute format('drop trigger if exists set_tenant_id on public.%I', t);
    execute format(
      'create trigger set_tenant_id before insert on public.%I for each row execute function public.set_tenant_id_from_user()',
      t
    );
  end loop;
end $$;

-- Backfill any rows that already slipped through with NULL tenant_id.
update public.documents d
set tenant_id = u.tenant_id
from public.users u
where u.id = d.user_id and d.tenant_id is null;
