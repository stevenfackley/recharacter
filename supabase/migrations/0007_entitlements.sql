-- One row = the account's paid unlock. Insert happens as the signed-in user after
-- server-side verification of the Stripe session (redirect-verification model).
create table public.entitlements (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null unique references auth.users (id) on delete cascade,
    kind text not null default 'case_unlock' check (kind in ('case_unlock')),
    stripe_session_id text not null unique,
    created_at timestamptz not null default now()
);

create index entitlements_owner_idx on public.entitlements (owner_id);

grant select, insert on public.entitlements to authenticated;
revoke update, delete, truncate on public.entitlements from authenticated, anon;

alter table public.entitlements enable row level security;
create policy entitlements_select_own on public.entitlements
    for select using (auth.uid() = owner_id);
create policy entitlements_insert_own on public.entitlements
    for insert with check (auth.uid() = owner_id);

-- Checkout sessions we've started and not yet verified; lets "restore purchase"
-- recover a paid session even if the success redirect never happened.
create table public.pending_checkouts (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users (id) on delete cascade,
    stripe_session_id text not null unique,
    created_at timestamptz not null default now()
);

create index pending_checkouts_owner_idx on public.pending_checkouts (owner_id);

grant select, insert, delete on public.pending_checkouts to authenticated;
revoke update, truncate on public.pending_checkouts from authenticated, anon;

alter table public.pending_checkouts enable row level security;
create policy pending_checkouts_select_own on public.pending_checkouts
    for select using (auth.uid() = owner_id);
create policy pending_checkouts_insert_own on public.pending_checkouts
    for insert with check (auth.uid() = owner_id);
create policy pending_checkouts_delete_own on public.pending_checkouts
    for delete using (auth.uid() = owner_id);
