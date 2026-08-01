-- Adds live call-state tracking so the iOS app can be notified the instant a
-- call starts (not just when it ends, which is all the original schema captured).
alter table public.calls add column if not exists status text not null default 'completed';
-- 'ringing'    -> webhook wrote this the moment Vapi's status-update fires (call answered)
-- 'completed'  -> end-of-call-report has landed with the full transcript/summary
alter table public.calls add column if not exists wearer_response text;
-- wearer_response: 'claimed' | 'declined' | null (no response) — what the companion
-- app recorded, independent of env IRIS_MODE. Logged only; does not yet reroute the
-- live call (see README "Known limitation").

-- The iOS app authenticates with the anon key, never the service role key, so it
-- needs its own narrow RLS policies instead of relying on the service-role bypass.
drop policy if exists "anon can read calls" on public.calls;
create policy "anon can read calls" on public.calls for select to anon using (true);

drop policy if exists "anon can set wearer_response" on public.calls;
create policy "anon can set wearer_response" on public.calls for update to anon
  using (true) with check (true);

grant select, update on public.calls to anon;
grant usage on schema public to anon;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'calls'
  ) then
    alter publication supabase_realtime add table public.calls;
  end if;
end $$;
