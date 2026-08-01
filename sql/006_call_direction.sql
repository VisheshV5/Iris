-- Lets the companion app show a live-call card for calls Iris PLACES, not just
-- calls she receives, and label each one correctly.
alter table public.calls add column if not exists direction text not null default 'inbound';
-- 'inbound'  -> someone called the founder's number
-- 'outbound' -> Iris placed the call on the founder's behalf

grant select, update on public.calls to anon;
grant select on public.calls to service_role;
