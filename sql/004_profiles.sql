-- Founder profiles: one row per authenticated app user. Feeds Iris's per-call
-- personalization (company, role, about) and the wearer-handoff phone number.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  company text,
  role text,
  about text,
  phone text,
  google_calendar_connected boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;

-- The backend reads the latest profile with the service-role key to personalize
-- each call; direct-SQL tables don't get Supabase's default role grants.
grant select on public.profiles to service_role;
