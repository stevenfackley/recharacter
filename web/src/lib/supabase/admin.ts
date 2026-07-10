import { createClient } from '@supabase/supabase-js'

/**
 * Service-role client — BYPASSES RLS. Server-only, and intentionally hard to
 * reach: the only production caller is account deletion (auth.admin.deleteUser,
 * whose FK cascades are the one sanctioned way to clear the insert-only
 * ledgers). Do not use this for feature queries — RLS through the user's own
 * session is the product's isolation guarantee.
 *
 * Returns null when SUPABASE_SERVICE_ROLE_KEY isn't configured so callers can
 * fail closed (refuse the operation) rather than crash at import time.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}
