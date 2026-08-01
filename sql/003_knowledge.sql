-- Knowledge base for Iris, structured so that "can I find it" and "am I allowed to
-- say it" are separate decisions. Retrieval proposes; the gate disposes.
--
-- Nothing here touches the `calls` table from 001/002 — these are new tables alongside it.

create extension if not exists pg_trgm;

-- Shared normalizer: lowercase, strip punctuation, collapse whitespace. Used both for
-- exact-alias matching and for clustering unanswered questions into gaps, so a phrasing
-- that clusters one way in one place clusters the same way in the other.
create or replace function public.kb_normalize(t text)
returns text language sql immutable parallel safe as $$
  select btrim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- GATE 1 lives in its own table, deliberately.
-- A guard stored inside the knowledge base can be outvoted by a good match inside
-- the knowledge base. This is consulted BEFORE retrieval runs at all.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.kb_restricted_topics (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  label text not null,
  -- Lowercase phrases. A question matches if any phrase appears in its normalized form.
  -- Substrings rather than regex on purpose: an operator can read this and predict it.
  patterns text[] not null default '{}',
  action text not null default 'escalate' check (action in ('escalate', 'refuse')),
  -- What Iris says while escalating. Never an answer — only an acknowledgement.
  deflection text,
  active boolean not null default true
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Entries. One entry answers exactly ONE question.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.kb_entries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The question in the OWNER's words. Bounds what this entry is allowed to cover.
  canonical_question text not null,
  -- The phrasings an END USER actually uses. Highest-leverage field in the schema:
  -- each one is a human asserting "this wording means this question".
  aliases text[] not null default '{}',
  tags text[] not null default '{}',
  category text,

  -- Short, TTS-safe. No lists, no URLs, no "see attached".
  answer_spoken text,
  -- Longer form, for channels where length is acceptable.
  answer_text text,

  -- Permissions ────────────────────────────────────────────────────────────
  scope text not null default 'organization' check (scope in ('organization', 'contact')),
  contact_id text,
  disclosure text not null default 'speak' check (disclosure in ('speak', 'paraphrase', 'context_only')),
  autonomy text not null default 'auto' check (autonomy in ('auto', 'confirm_back', 'escalate_always')),
  sensitivity text not null default 'public' check (sensitivity in ('public', 'internal', 'restricted')),
  -- Per-entry floor, never a global threshold: a price quote can demand 0.9 while
  -- opening hours is fine at 0.7.
  min_confidence real not null default 0.7 check (min_confidence between 0 and 1),

  -- Freshness ──────────────────────────────────────────────────────────────
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'superseded', 'retired')),
  effective_from timestamptz,
  effective_until timestamptz,
  review_after timestamptz,
  last_confirmed_at timestamptz,

  -- Provenance ─────────────────────────────────────────────────────────────
  version int not null default 1,
  source_reference text,
  approved_by text,
  approved_at timestamptz,
  supersedes uuid references public.kb_entries(id) on delete set null,

  -- The two-question confirmation. NULL means "not yet asked" — distinct from
  -- a "no", which is a real answer that routes the entry somewhere narrower.
  confirmed_accurate boolean,
  confirmed_shareable boolean,

  constraint kb_contact_scope_needs_contact
    check (scope <> 'contact' or contact_id is not null),

  -- Something that may never be spoken cannot also be something the agent answers
  -- with. Enforced here rather than in a prompt, because a prompt is a request.
  constraint kb_context_only_is_never_speakable
    check (disclosure <> 'context_only' or answer_spoken is null),

  -- No code path can publish a fact by omission.
  constraint kb_publish_requires_both_answers
    check (status <> 'approved' or (confirmed_accurate is not null and confirmed_shareable is not null)),
  constraint kb_publish_requires_accuracy
    check (status <> 'approved' or confirmed_accurate),

  -- An approved entry that is allowed to speak must have something to say.
  constraint kb_speakable_approved_entry_has_answer
    check (status <> 'approved' or disclosure = 'context_only' or answer_spoken is not null)
);

-- Aliases and the owner's own phrasing carry the same top weight; body text is
-- weaker; tags are weakest because matching a tag means matching a topic, not a question.
--
-- Maintained by a trigger rather than declared GENERATED: array_to_string is only
-- STABLE, not IMMUTABLE, so Postgres rejects it inside a generation expression.
alter table public.kb_entries add column if not exists search_vector tsvector;

create or replace function public.kb_entries_refresh_search() returns trigger
language plpgsql as $$
begin
  new.search_vector :=
    setweight(to_tsvector('english', coalesce(new.canonical_question, '')), 'A') ||
    setweight(to_tsvector('english', array_to_string(new.aliases, ' ')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.answer_text, new.answer_spoken, '')), 'C') ||
    setweight(to_tsvector('english', array_to_string(new.tags, ' ')), 'D');
  return new;
end $$;

drop trigger if exists kb_entries_search_trg on public.kb_entries;
create trigger kb_entries_search_trg
  before insert or update on public.kb_entries
  for each row execute function public.kb_entries_refresh_search();

-- Backfill anything that predates the trigger.
update public.kb_entries set updated_at = updated_at where search_vector is null;

create index if not exists kb_entries_search_idx on public.kb_entries using gin (search_vector);
create index if not exists kb_entries_canonical_trgm_idx on public.kb_entries using gin (public.kb_normalize(canonical_question) gin_trgm_ops);
create index if not exists kb_entries_status_idx on public.kb_entries (status);
create index if not exists kb_entries_review_idx on public.kb_entries (review_after) where status = 'approved';

-- ─────────────────────────────────────────────────────────────────────────────
-- Retrieval + GATE 2 (eligibility), in one round trip.
--
-- Eligibility is applied inside the query rather than in application code: an entry
-- scoped to a different caller never leaves the database at all, so there is no
-- object in server memory that a later bug could accidentally speak.
--
-- Note that `disclosure` is deliberately NOT filtered here. context_only entries must
-- still be retrievable — they are exactly the material that rides along to the owner
-- during an escalation. Suppressing them happens at answer time, not at retrieval time.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.kb_search(
  p_query text,
  p_contact_id text default null,
  p_limit int default 5
)
returns table (
  id uuid,
  canonical_question text,
  answer_spoken text,
  answer_text text,
  scope text,
  contact_id text,
  disclosure text,
  autonomy text,
  sensitivity text,
  min_confidence real,
  review_after timestamptz,
  last_confirmed_at timestamptz,
  match_type text,
  score real
)
language sql stable parallel safe as $$
  with q as (
    select public.kb_normalize(p_query) as nq,
           websearch_to_tsquery('english', coalesce(p_query, '')) as tsq
  ),
  scored as (
    select
      e.*,
      exists (select 1 from unnest(e.aliases) a where public.kb_normalize(a) = q.nq) as alias_exact,
      public.kb_normalize(e.canonical_question) = q.nq as question_exact,
      greatest(
        similarity(public.kb_normalize(e.canonical_question), q.nq),
        coalesce((select max(similarity(public.kb_normalize(a), q.nq)) from unnest(e.aliases) a), 0)
      ) as trgm,
      e.search_vector @@ q.tsq as fts_hit,
      -- Did the query match only through tags? Then we found a topic, not a question.
      e.search_vector @@ q.tsq and not (
        setweight(to_tsvector('english', coalesce(e.canonical_question, '')), 'A') ||
        setweight(to_tsvector('english', array_to_string(e.aliases, ' ')), 'A') ||
        setweight(to_tsvector('english', coalesce(e.answer_text, e.answer_spoken, '')), 'C')
      ) @@ q.tsq as tag_only
    from public.kb_entries e, q
    where e.status = 'approved'
      and (e.effective_from is null or e.effective_from <= now())
      and (e.effective_until is null or e.effective_until > now())
      and (e.scope = 'organization'
           or (e.scope = 'contact' and e.contact_id is not distinct from p_contact_id))
  )
  select
    s.id, s.canonical_question, s.answer_spoken, s.answer_text, s.scope, s.contact_id,
    s.disclosure, s.autonomy, s.sensitivity, s.min_confidence, s.review_after, s.last_confirmed_at,
    case
      when s.alias_exact    then 'alias_exact'
      when s.question_exact then 'question_exact'
      when s.tag_only       then 'tag_only'
      when s.fts_hit        then 'lexical'
      else                       'fuzzy'
    end as match_type,
    case
      -- A curated alias is a human's assertion, not a similarity score. It wins outright.
      when s.alias_exact    then 1.0::real
      when s.question_exact then 0.97::real
      -- A tag hit is a reason to look, never a reason to answer. Capped below any
      -- sane min_confidence so it can only ever produce a CLARIFY.
      when s.tag_only       then least(0.45, s.trgm * 0.5 + 0.2)::real
      when s.fts_hit        then least(0.95, s.trgm + 0.15)::real
      else                       s.trgm::real
    end as score
  from scored s
  where s.alias_exact or s.question_exact or s.fts_hit or s.trgm >= 0.30
  order by score desc, s.last_confirmed_at desc nulls last
  limit greatest(1, p_limit)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The feedback loop. Without this log, "improve accuracy" is guesswork.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.kb_usage_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  vapi_call_id text,
  query text not null,
  normalized_key text,
  entry_id uuid references public.kb_entries(id) on delete set null,
  match_type text,
  confidence real,
  -- Exactly three outcomes are possible at the gate.
  outcome text not null check (outcome in ('answer', 'clarify', 'escalate')),
  -- Which gate stopped it, when one did. This is what makes a bad answer diagnosable.
  gate_failed text check (gate_failed in ('restricted', 'eligibility', 'confidence', 'ambiguity', 'autonomy', 'disclosure', 'no_match')),
  spoken boolean not null default false,
  latency_ms int,
  -- Filled in later: what actually happened after this entry was used.
  followed_by text check (followed_by in ('resolved', 'clarified_then_resolved', 'escalated_after', 'corrected_by_owner'))
);

create index if not exists kb_usage_entry_idx on public.kb_usage_log (entry_id, created_at desc);
create index if not exists kb_usage_key_idx on public.kb_usage_log (normalized_key);

-- ─────────────────────────────────────────────────────────────────────────────
-- Gap detection. Asked once is noise; asked three times is a missing entry.
-- Verbatim phrasings are kept, not just a count — they become the alias list when
-- the gap is promoted, which is the whole point.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.kb_gaps (
  id uuid primary key default gen_random_uuid(),
  normalized_key text unique not null,
  verbatim_questions text[] not null default '{}',
  occurrences int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'observed' check (status in ('observed', 'drafted', 'dismissed', 'promoted')),
  drafted_entry_id uuid references public.kb_entries(id) on delete set null
);

create or replace function public.kb_record_gap(p_key text, p_verbatim text)
returns int language plpgsql as $$
declare n int;
begin
  insert into public.kb_gaps (normalized_key, verbatim_questions)
  values (p_key, array[p_verbatim])
  on conflict (normalized_key) do update
    set occurrences = public.kb_gaps.occurrences + 1,
        last_seen_at = now(),
        -- Keep distinct phrasings only; duplicates add count, not alias candidates.
        verbatim_questions = (
          select array_agg(distinct v)
          from unnest(public.kb_gaps.verbatim_questions || p_verbatim) v
        )
  returning occurrences into n;
  return n;
end $$;

-- When a clarification resolves to an entry, the caller's ORIGINAL wording is now
-- proven to mean that entry — a human just confirmed it. That is the definition of an
-- alias, produced for free by the system's own moment of confusion.
--
-- Auto-accepting these is safe in a way that auto-publishing an answer is not: an alias
-- only changes which APPROVED entry is found, never what is said. The blast radius of a
-- wrong alias is one clarifying question.
create or replace function public.kb_add_alias(p_entry_id uuid, p_alias text)
returns void language sql as $$
  update public.kb_entries
     set aliases = (select array_agg(distinct a) from unnest(aliases || p_alias) a),
         updated_at = now()
   where id = p_entry_id
     and not exists (
       select 1 from unnest(aliases) a where public.kb_normalize(a) = public.kb_normalize(p_alias)
     )
$$;

-- Volatile facts return to the owner as a one-tap "still true?" rather than silently
-- retiring. Retiring an unreviewed fact only trades a wrong answer for a needless escalation.
create or replace view public.kb_review_due as
  select id, canonical_question, answer_spoken, category, sensitivity, review_after, last_confirmed_at
    from public.kb_entries
   where status = 'approved' and review_after is not null and review_after <= now()
   order by review_after;

-- ─────────────────────────────────────────────────────────────────────────────
-- Escalations. Written the instant the gate declines to answer, so the wearer can be
-- alerted while the caller is still on the line.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.kb_escalations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  vapi_call_id text,
  -- Vapi's live call-control URL. Held so the owner's answer can be injected into a
  -- call that is still in progress, long after the tool call itself has returned.
  control_url text,
  caller_number text,
  question text not null,
  reason text not null check (reason in ('restricted', 'eligibility', 'confidence', 'ambiguity', 'autonomy', 'disclosure', 'no_match', 'agent_requested')),
  -- disclosure='context_only' material. Goes to the WEARER only. Never spoken.
  context_for_wearer text,
  -- Pre-filled draft so the owner taps "yes, send that" instead of composing.
  -- Unconfirmed knowledge may assist the owner; it may never speak to a caller.
  suggested_answer text,
  suggested_entry_id uuid references public.kb_entries(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'answered', 'expired', 'dismissed')),
  owner_answer text,
  answered_at timestamptz,
  delivered_at timestamptz
);

create index if not exists kb_escalations_pending_idx on public.kb_escalations (status, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Access. The service role (this server) is the only thing that may read entries:
-- context_only material and contact-scoped facts must never be reachable with the
-- anon key, which is exactly the failure mode a file-based platform KB has.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.kb_entries enable row level security;
alter table public.kb_restricted_topics enable row level security;
alter table public.kb_usage_log enable row level security;
alter table public.kb_gaps enable row level security;
alter table public.kb_escalations enable row level security;

grant usage on schema public to service_role;
grant all on public.kb_entries, public.kb_restricted_topics, public.kb_usage_log,
             public.kb_gaps, public.kb_escalations to service_role;

-- The companion app is the one exception: it reads pending escalations (including the
-- wearer-only context) and writes the owner's answer back. Same anon-key trust model
-- the `calls` table already uses.
drop policy if exists "anon can read escalations" on public.kb_escalations;
create policy "anon can read escalations" on public.kb_escalations for select to anon using (true);

drop policy if exists "anon can answer escalations" on public.kb_escalations;
create policy "anon can answer escalations" on public.kb_escalations for update to anon
  using (true) with check (true);

grant select, update on public.kb_escalations to anon;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kb_escalations'
  ) then
    alter publication supabase_realtime add table public.kb_escalations;
  end if;
end $$;
