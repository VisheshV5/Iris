-- Google Calendar: the app captures session.provider_refresh_token immediately
-- after the OAuth redirect (the only moment Supabase exposes it) and persists it
-- here so the server can mint access tokens after the first one expires (~1h).
alter table public.profiles add column if not exists google_refresh_token text;

-- Access model is unchanged: the owner-only RLS policies from 004 already cover
-- the new column (policies are row-scoped, not column-scoped). Re-issue the
-- grants so any database where they were applied column-by-column picks it up.
grant select, insert, update on public.profiles to authenticated;
grant select on public.profiles to service_role;
