-- BYOK: one encrypted provider key per user. The key is AES-256-GCM ciphertext,
-- encrypted server-side before insert; the database never sees plaintext.
create table public.ai_credentials (
    owner_id uuid primary key references auth.users (id) on delete cascade,
    encrypted_key text not null,      -- base64: iv || ciphertext || authTag
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Explicit grants: Postgres checks table privileges BEFORE RLS, and schema default
-- privileges vary by Supabase CLI/image version (CI runs latest). RLS is the only
-- intentional gate.
grant select, insert, update, delete on public.ai_credentials to authenticated;

alter table public.ai_credentials enable row level security;

create policy ai_credentials_select_own on public.ai_credentials
    for select using (auth.uid() = owner_id);
create policy ai_credentials_insert_own on public.ai_credentials
    for insert with check (auth.uid() = owner_id);
create policy ai_credentials_update_own on public.ai_credentials
    for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy ai_credentials_delete_own on public.ai_credentials
    for delete using (auth.uid() = owner_id);

-- Per-call usage ledger (managed tier bills from this in Plan 08; BYOK rows are
-- informational). Insert-only from the user's own session; no update/delete policies.
create table public.ai_usage (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users (id) on delete cascade,
    task text not null,
    model text not null,
    byok boolean not null default false,
    input_tokens integer not null,
    output_tokens integer not null,
    created_at timestamptz not null default now()
);

create index ai_usage_owner_created_idx on public.ai_usage (owner_id, created_at desc);

-- Insert-only ledger: grant no update/delete at all — the GRANT layer enforces
-- immutability even before RLS gets a say.
grant select, insert on public.ai_usage to authenticated;

alter table public.ai_usage enable row level security;

create policy ai_usage_select_own on public.ai_usage
    for select using (auth.uid() = owner_id);
create policy ai_usage_insert_own on public.ai_usage
    for insert with check (auth.uid() = owner_id);
