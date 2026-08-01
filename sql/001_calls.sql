create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  vapi_call_id text unique,
  caller_number text,
  caller_name text,
  callback_number text,
  reason text,
  summary text,
  transcript text,
  branch text not null default 'busy',
  started_at timestamptz,
  ended_at timestamptz,
  raw jsonb
);

-- Service-role key bypasses RLS; enabling it keeps the anon key locked out.
alter table public.calls enable row level security;

-- Tables created via direct SQL don't inherit Supabase's role grants automatically.
grant usage on schema public to service_role;
grant all on public.calls to service_role;
