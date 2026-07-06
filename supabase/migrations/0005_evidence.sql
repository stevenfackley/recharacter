-- The Kurta-relevant context that personalizes the evidence checklist.
create table public.case_context (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null unique references public.cases (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    condition_category text not null check (condition_category in
        ('ptsd','tbi','depression_anxiety','adjustment_disorder','other_mh','unsure')),
    mst_involved boolean not null default false,
    treated_in_service boolean not null default false,
    has_va_rating boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index case_context_owner_idx on public.case_context (owner_id);

grant select, insert, update, delete on public.case_context to authenticated;
revoke truncate on public.case_context from authenticated, anon;

alter table public.case_context enable row level security;
create policy case_context_select_own on public.case_context
    for select using (auth.uid() = owner_id);
create policy case_context_insert_own on public.case_context
    for insert with check (auth.uid() = owner_id);
create policy case_context_update_own on public.case_context
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy case_context_delete_own on public.case_context
    for delete using (auth.uid() = owner_id);

-- One row per recommended checklist item; status is veteran-reported.
create table public.evidence_items (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null references public.cases (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    item_type text not null check (item_type in
        ('dd214','service_treatment_records','va_rating_letter','civilian_mh_records',
         'buddy_statement','nexus_letter','personal_statement')),
    status text not null default 'needed' check (status in
        ('needed','requested','collected','not_applicable')),
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (case_id, item_type)
);

create index evidence_items_owner_idx on public.evidence_items (owner_id);

grant select, insert, update, delete on public.evidence_items to authenticated;
revoke truncate on public.evidence_items from authenticated, anon;

alter table public.evidence_items enable row level security;
create policy evidence_items_select_own on public.evidence_items
    for select using (auth.uid() = owner_id);
create policy evidence_items_insert_own on public.evidence_items
    for insert with check (auth.uid() = owner_id);
create policy evidence_items_update_own on public.evidence_items
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy evidence_items_delete_own on public.evidence_items
    for delete using (auth.uid() = owner_id);
