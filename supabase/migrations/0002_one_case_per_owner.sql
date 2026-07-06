-- MVP invariant: exactly one case per veteran, enforced by the database rather than
-- by convention. Without this, two concurrent first requests can both pass the
-- "select finds nothing" check in getOrCreateCase and insert two rows.
-- If multi-case support lands later, drop this in favor of a partial unique index
-- on an is_active flag.
create unique index cases_one_per_owner on public.cases (owner_id);
