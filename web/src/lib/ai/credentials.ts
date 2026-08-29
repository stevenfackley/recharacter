import { eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { aiCredentials } from '@/db/schema'

/**
 * The BYOK credential store. Only ciphertext crosses this boundary — encryption
 * and decryption stay in lib/ai/crypto.ts, bound to the owner id as AAD, so a row
 * read for the wrong owner cannot be turned back into a usable key.
 */

export async function getEncryptedKey(ownerId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ encryptedKey: aiCredentials.encryptedKey })
    .from(aiCredentials)
    .where(eq(aiCredentials.ownerId, ownerId))
    .limit(1)
  return row?.encryptedKey ?? null
}

export async function saveEncryptedKey(ownerId: string, ciphertext: string): Promise<void> {
  await getDb()
    .insert(aiCredentials)
    .values({ ownerId, encryptedKey: ciphertext })
    .onConflictDoUpdate({
      target: aiCredentials.ownerId,
      set: { encryptedKey: ciphertext, updatedAt: new Date() },
    })
}

export async function deleteEncryptedKey(ownerId: string): Promise<void> {
  await getDb().delete(aiCredentials).where(eq(aiCredentials.ownerId, ownerId))
}

/** When the owner's key was first saved — the settings page shows this, never the key. */
export async function credentialCreatedAt(ownerId: string): Promise<Date | null> {
  const [row] = await getDb()
    .select({ createdAt: aiCredentials.createdAt })
    .from(aiCredentials)
    .where(eq(aiCredentials.ownerId, ownerId))
    .limit(1)
  return row?.createdAt ?? null
}
