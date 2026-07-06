-- A veteran's discharge-upgrade effort. Owned by exactly one auth user.
create table public.cases (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index cases_owner_id_idx on public.cases (owner_id);

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
