export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  /** Every key under the prefix, fully paginated. */
  list(prefix: string): Promise<string[]>
  remove(keys: string[]): Promise<void>
}

export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, { body: Uint8Array; contentType: string }>()
  async put(key: string, body: Uint8Array, contentType: string) { this.objects.set(key, { body: new Uint8Array(body), contentType }) }
  async get(key: string) {
    const found = this.objects.get(key)
    return found ? new Uint8Array(found.body) : null
  }
  async list(prefix: string) { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort() }
  async remove(keys: string[]) { for (const k of keys) this.objects.delete(k) }
}
