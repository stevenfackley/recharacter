-- The four facts discharge routing needs, exactly one row per case.
-- Values mirror the .NET RulesEngine enums verbatim (PascalCase) so the routing
-- client can pass them through without mapping.
create table public.service_facts (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null unique references public.cases (id) on delete cascade,
    owner_id uuid not null references auth.users (id) on delete cascade,
    branch text not null check (branch in
        ('Army','Navy','MarineCorps','AirForce','SpaceForce','CoastGuard')),
    discharge_date date not null,
    characterization text not null check (characterization in
        ('Honorable','GeneralUnderHonorable','OtherThanHonorable',
         'BadConductDischarge','DishonorableDischarge','Uncharacterized')),
    was_general_court_martial boolean not null default false,
    source text not null default 'manual' check (source in ('manual','extracted')),
    confirmed boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index service_facts_owner_idx on public.service_facts (owner_id);

-- Declare the full privilege state (grant AND revoke — defaults may have granted more).
grant select, insert, update, delete on public.service_facts to authenticated;
revoke truncate on public.service_facts from authenticated, anon;

alter table public.service_facts enable row level security;

create policy service_facts_select_own on public.service_facts
    for select using (auth.uid() = owner_id);
create policy service_facts_insert_own on public.service_facts
    for insert with check (auth.uid() = owner_id);
create policy service_facts_update_own on public.service_facts
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy service_facts_delete_own on public.service_facts
    for delete using (auth.uid() = owner_id);

-- Private bucket for uploaded records. Path convention: {user_id}/{case_id}/{file}.
-- Owner-scoping is enforced by matching the first path segment to auth.uid().
insert into storage.buckets (id, name, public)
values ('case-documents', 'case-documents', false)
on conflict (id) do nothing;

create policy case_docs_select_own on storage.objects
    for select to authenticated
    using (bucket_id = 'case-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy case_docs_insert_own on storage.objects
    for insert to authenticated
    with check (bucket_id = 'case-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy case_docs_delete_own on storage.objects
    for delete to authenticated
    using (bucket_id = 'case-documents' and (storage.foldername(name))[1] = auth.uid()::text);
