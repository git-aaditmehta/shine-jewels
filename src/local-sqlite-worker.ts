import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { BindableValue } from '@sqlite.org/sqlite-wasm'

type RequestMessage = { id: string; sql?: string; bind?: BindableValue[]; action?: 'put-image'|'get-image'|'has-image'|'delete-image'; path?: string; data?: string }
type ResponseMessage = { id: string; rows?: unknown[]; error?: string; persistent: boolean }

type LocalDatabase=InstanceType<Awaited<ReturnType<typeof sqlite3InitModule>>['oo1']['DB']>
let db: LocalDatabase
let persistent = false
const memoryImageCache = new Map<string, string>()

const ready = sqlite3InitModule().then(async (sqlite3) => {
  // 1. Try OPFS SAH Pool VFS (works without SharedArrayBuffer / COOP / COEP headers across modern Safari and Chrome)
  if (typeof sqlite3.installOpfsSAHPoolVfs === 'function' && 'storage' in navigator && typeof navigator.storage.getDirectory === 'function') {
    try {
      const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: 'shine-jewels-pool' })
      db = new poolUtil.OpfsSAHPoolDb('/shine-jewels.sqlite3')
      persistent = true
    } catch (sahErr) {
      console.warn('OpfsSAHPoolDb initialization failed, trying standard OpfsDb:', sahErr)
    }
  }

  // 2. Try standard OpfsDb
  if (!db && sqlite3.oo1?.OpfsDb && 'storage' in navigator && typeof navigator.storage.getDirectory === 'function') {
    try {
      const root = await navigator.storage.getDirectory()
      await root.getDirectoryHandle('shine-jewels', { create: true })
      db = new sqlite3.oo1.OpfsDb('/shine-jewels/metadata.sqlite3')
      persistent = true
    } catch {
      try {
        db = new sqlite3.oo1.OpfsDb('shine-jewels-metadata.sqlite3')
        persistent = true
      } catch (opfsErr) {
        console.warn('Standard OpfsDb initialization failed:', opfsErr)
      }
    }
  }

  // 3. Fallback to in-memory SQLite if OPFS is not supported or permitted (e.g. Safari Private Browsing)
  if (!db) {
    console.warn('Falling back to in-memory SQLite database')
    db = new sqlite3.oo1.DB(':memory:', 'ct')
    persistent = false
  }

  db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS local_sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS pending_operations (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_image_metadata (image_key TEXT PRIMARY KEY, product_id TEXT NOT NULL, representation TEXT NOT NULL, size_bytes INTEGER NOT NULL, checksum TEXT NOT NULL, image_version INTEGER NOT NULL, local_path TEXT NOT NULL, integrity_state TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS storage_accounting (key TEXT PRIMARY KEY, bytes INTEGER NOT NULL);`)
})

async function imageFile(path: string, create: boolean) {
  const storage = (self as unknown as { navigator: { storage: { getDirectory: () => Promise<FileSystemDirectoryHandle> } } }).navigator.storage
  if (!storage || typeof storage.getDirectory !== 'function') throw new Error('OPFS storage unavailable')
  const root = await storage.getDirectory(), images = await root.getDirectoryHandle('shine-jewels-images', { create })
  return images.getFileHandle(path, { create })
}

async function writeImageToDisk(path: string, data: string): Promise<boolean> {
  const handle = await imageFile(path, true)
  if ('createSyncAccessHandle' in handle && typeof (handle as unknown as { createSyncAccessHandle: () => Promise<{ truncate: (n: number) => void; write: (b: Uint8Array, o?: { at: number }) => number; flush: () => void; close: () => void }> }).createSyncAccessHandle === 'function') {
    const accessHandle = await (handle as unknown as { createSyncAccessHandle: () => Promise<{ truncate: (n: number) => void; write: (b: Uint8Array, o?: { at: number }) => number; flush: () => void; close: () => void }> }).createSyncAccessHandle()
    try {
      const encoder = new TextEncoder()
      const encoded = encoder.encode(data)
      accessHandle.truncate(0)
      accessHandle.write(encoded, { at: 0 })
      accessHandle.flush()
      return true
    } finally {
      accessHandle.close()
    }
  }
  if ('createWritable' in handle && typeof (handle as unknown as { createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }> }).createWritable === 'function') {
    const writer = await (handle as unknown as { createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }> }).createWritable()
    await writer.write(data)
    await writer.close()
    return true
  }
  return false
}

async function readImageFromDisk(path: string): Promise<string | null> {
  const handle = await imageFile(path, false)
  try {
    const file = await handle.getFile()
    if (file && file.size > 0) {
      return await file.text()
    }
  } catch { /* fallback to sync handle */ }

  if ('createSyncAccessHandle' in handle && typeof (handle as unknown as { createSyncAccessHandle: () => Promise<{ getSize: () => number; read: (b: Uint8Array, o?: { at: number }) => number; close: () => void }> }).createSyncAccessHandle === 'function') {
    const accessHandle = await (handle as unknown as { createSyncAccessHandle: () => Promise<{ getSize: () => number; read: (b: Uint8Array, o?: { at: number }) => number; close: () => void }> }).createSyncAccessHandle()
    try {
      const size = accessHandle.getSize()
      if (size === 0) return ''
      const buf = new Uint8Array(size)
      accessHandle.read(buf, { at: 0 })
      const decoder = new TextDecoder()
      return decoder.decode(buf)
    } finally {
      accessHandle.close()
    }
  }
  return null
}

self.addEventListener('message', async (event: MessageEvent<RequestMessage>) => {
  const { id, sql, bind = [] } = event.data
  try {
    await ready
    if (event.data.action === 'put-image') {
      if (!event.data.path || event.data.data === undefined) throw new Error('Image path and data are required.')
      let saved = false
      try {
        saved = await writeImageToDisk(event.data.path, event.data.data)
      } catch (err) {
        console.warn('Direct OPFS image write error, falling back to memory cache:', err)
      }
      if (!saved) {
        memoryImageCache.set(event.data.path, event.data.data)
      }
      db.exec({ sql: 'INSERT INTO storage_accounting(key,bytes) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes', bind: [`image:${event.data.path}`, new Blob([event.data.data]).size] })
      self.postMessage({ id, persistent } satisfies ResponseMessage)
      return
    }
    if (event.data.action === 'get-image') {
      if (!event.data.path) throw new Error('Image path is required.')
      const mem = memoryImageCache.get(event.data.path)
      if (mem) {
        self.postMessage({ id, rows: [mem], persistent } satisfies ResponseMessage)
        return
      }
      try {
        const text = await readImageFromDisk(event.data.path)
        if (text !== null) {
          self.postMessage({ id, rows: [text], persistent } satisfies ResponseMessage)
          return
        }
      } catch { /* ignore */ }
      self.postMessage({ id, rows: [''], persistent } satisfies ResponseMessage)
      return
    }
    if (event.data.action === 'has-image') {
      if (!event.data.path) throw new Error('Image path is required.')
      if (memoryImageCache.has(event.data.path)) {
        self.postMessage({ id, rows: [true], persistent } satisfies ResponseMessage)
        return
      }
      try {
        const handle = await imageFile(event.data.path, false)
        const file = await handle.getFile()
        self.postMessage({ id, rows: [file.size > 0], persistent } satisfies ResponseMessage)
      } catch {
        self.postMessage({ id, rows: [false], persistent } satisfies ResponseMessage)
      }
      return
    }
    if (event.data.action === 'delete-image') {
      if (!event.data.path) throw new Error('Image path is required.')
      memoryImageCache.delete(event.data.path)
      try {
        const storage = (self as unknown as { navigator: { storage: { getDirectory: () => Promise<FileSystemDirectoryHandle> } } }).navigator.storage
        if (storage?.getDirectory) {
          const root = await storage.getDirectory(), images = await root.getDirectoryHandle('shine-jewels-images', { create: false })
          await images.removeEntry(event.data.path)
        }
      } catch {
        /* ignore missing */
      }
      db.exec({ sql: 'DELETE FROM storage_accounting WHERE key=?', bind: [`image:${event.data.path}`] })
      self.postMessage({ id, rows: [true], persistent } satisfies ResponseMessage)
      return
    }
    if (!sql) throw new Error('SQL is required.')
    const rows: unknown[] = []
    db.exec({ sql, bind, rowMode: 'object', callback: (row: unknown) => { rows.push(row) } })
    self.postMessage({ id, rows, persistent } satisfies ResponseMessage)
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : 'SQLite operation failed', persistent } satisfies ResponseMessage)
  }
})
