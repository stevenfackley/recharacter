-- The four Kurta slots, one row per case. Text is ALWAYS the veteran's own
-- editable words (AI may propose phrasing; only accepted text lands here).
create table public.nexus_answers (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null unique references public.cases (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    q1_condition text not null default '',
    q2_during_service text not null default '',
    q3_mitigation text not null default '',
    q4_outweigh text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index nexus_answers_owner_idx on public.nexus_answers (owner_id);

grant select, insert, update, delete on public.nexus_answers to authenticated;
revoke truncate on public.nexus_answers from authenticated, anon;

alter table public.nexus_answers enable row level security;
create policy nexus_answers_select_own on public.nexus_answers
    for select using (auth.uid() = owner_id);
create policy nexus_answers_insert_own on public.nexus_answers
    for insert with check (auth.uid() = owner_id);
create policy nexus_answers_update_own on public.nexus_answers
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy nexus_answers_delete_own on public.nexus_answers
    for delete using (auth.uid() = owner_id);

-- Generated-then-edited documents. content is the veteran's working copy.
create table public.drafts (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null references public.cases (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    kind text not null check (kind in ('personal_statement','cover_letter')),
    content text not null,
    edited boolean not null default false,
    generated_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (case_id, kind)
);

create index drafts_owner_idx on public.drafts (owner_id);

grant select, insert, update, delete on public.drafts to authenticated;
revoke truncate on public.drafts from authenticated, anon;

alter table public.drafts enable row level security;
create policy drafts_select_own on public.drafts
    for select using (auth.uid() = owner_id);
create policy drafts_insert_own on public.drafts
    for insert with check (auth.uid() = owner_id);
create policy drafts_update_own on public.drafts
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy drafts_delete_own on public.drafts
    for delete using (auth.uid() = owner_id);
