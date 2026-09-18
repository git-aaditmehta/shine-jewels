import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { BindableValue } from '@sqlite.org/sqlite-wasm'

type RequestMessage = { id: string; sql?: string; bind?: BindableValue[]; action?: 'put-image'|'get-image'; path?: string; data?: string }
type ResponseMessage = { id: string; rows?: unknown[]; error?: string; persistent: boolean }

type LocalDatabase=InstanceType<Awaited<ReturnType<typeof sqlite3InitModule>>['oo1']['DB']>
let db: LocalDatabase
let persistent=false
const ready=sqlite3InitModule().then(sqlite3=>{
  // OpfsDb is the supported SQLite WASM persistence API. Checking a non-standard
  // `sqlite3.opfs` property selected the memory fallback on supported browsers.
  try {
    if(!sqlite3.oo1.OpfsDb || !navigator.storage?.getDirectory) throw new Error('OPFS is unavailable')
    db=new sqlite3.oo1.OpfsDb('/shine-jewels/metadata.sqlite3')
    persistent=true
  } catch {
    db=new sqlite3.oo1.DB(':memory:', 'ct')
  }
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS local_sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS pending_operations (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_image_metadata (image_key TEXT PRIMARY KEY, product_id TEXT NOT NULL, representation TEXT NOT NULL, size_bytes INTEGER NOT NULL, checksum TEXT NOT NULL, image_version INTEGER NOT NULL, local_path TEXT NOT NULL, integrity_state TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS storage_accounting (key TEXT PRIMARY KEY, bytes INTEGER NOT NULL);`)
})

async function imageFile(path:string,create:boolean){
  const storage=(self as unknown as {navigator:{storage:{getDirectory:()=>Promise<FileSystemDirectoryHandle>}}}).navigator.storage
  const root=await storage.getDirectory(),images=await root.getDirectoryHandle('shine-jewels-images',{create})
  return images.getFileHandle(path,{create})
}

self.addEventListener('message', async (event: MessageEvent<RequestMessage>) => {
  const { id, sql, bind = [] } = event.data
  try {
    await ready
    if(event.data.action==='put-image'){
      if(!event.data.path||event.data.data===undefined)throw new Error('Image path and data are required.')
      const handle=await imageFile(event.data.path,true),writer=await handle.createWritable()
      await writer.write(event.data.data);await writer.close()
      db.exec({sql:'INSERT INTO storage_accounting(key,bytes) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes',bind:[`image:${event.data.path}`,new Blob([event.data.data]).size]})
      self.postMessage({id,persistent} satisfies ResponseMessage);return
    }
    if(event.data.action==='get-image'){
      if(!event.data.path)throw new Error('Image path is required.')
      const file=await (await imageFile(event.data.path,false)).getFile()
      self.postMessage({id,rows:[await file.text()],persistent} satisfies ResponseMessage);return
    }
    if(!sql)throw new Error('SQL is required.')
    const rows: unknown[] = []
    db.exec({ sql, bind, rowMode: 'object', callback: (row: unknown) => { rows.push(row) } })
    self.postMessage({ id, rows, persistent } satisfies ResponseMessage)
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : 'SQLite operation failed', persistent } satisfies ResponseMessage)
  }
})
