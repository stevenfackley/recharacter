-- A veteran's discharge-upgrade effort. Owned by exactly one auth user.
create table public.cases (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index cases_owner_id_idx on public.cases (owner_id);

-- Table-level privileges are the FIRST gate; RLS below is the second. Grant explicitly
-- rather than relying on the schema's default privileges — those vary by Supabase
-- CLI/image version (CI runs latest and does not apply them), and RLS should be the
-- only intentional gate. anon gets select so unauthenticated reads return an
-- RLS-filtered empty set instead of a hard permission error.
grant select, insert, update, delete on public.cases to authenticated;
grant select on public.cases to anon;

-- Row-level security: a user may touch ONLY their own cases. Default-deny once enabled.
alter table public.cases enable row level security;

create policy cases_select_own on public.cases
    for select using (auth.uid() = owner_id);

create policy cases_insert_own on public.cases
    for insert with check (auth.uid() = owner_id);

create policy cases_update_own on public.cases
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy cases_delete_own on public.cases
    for delete using (auth.uid() = owner_id);
