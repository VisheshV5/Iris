-- Signing in changed the app's Postgres role from `anon` to `authenticated`, but
-- calls/kb_escalations were only ever granted to `anon` — so every read failed with
-- "permission denied for table calls" the moment auth landed (no live-call card, no
-- Messages, no spoken announcements). Grant the same access to both roles.

grant usage on schema public to authenticated;
grant select, update on public.calls to authenticated;
grant select, update on public.kb_escalations to authenticated;

-- RLS policies are per-role too: the existing ones name `anon` only.
drop policy if exists "authenticated can read calls" on public.calls;
create policy "authenticated can read calls" on public.calls
  for select to authenticated using (true);

drop policy if exists "authenticated can set wearer_response" on public.calls;
create policy "authenticated can set wearer_response" on public.calls
  for update to authenticated using (true) with check (true);

drop policy if exists "authenticated can read escalations" on public.kb_escalations;
create policy "authenticated can read escalations" on public.kb_escalations
  for select to authenticated using (true);

drop policy if exists "authenticated can answer escalations" on public.kb_escalations;
create policy "authenticated can answer escalations" on public.kb_escalations
  for update to authenticated using (true) with check (true);
