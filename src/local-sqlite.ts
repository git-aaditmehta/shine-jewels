import type { BindableValue } from '@sqlite.org/sqlite-wasm'

type WorkerReply = { id: string; rows?: unknown[]; error?: string; persistent: boolean }

/** Storage boundary for SQLite WASM metadata. Images intentionally remain separate OPFS files. */
export class LocalSqlite {
  private readonly worker = new Worker(new URL('./local-sqlite-worker.ts', import.meta.url), { type: 'module' })
  private readonly pending = new Map<string, { resolve: (value: WorkerReply) => void; reject: (reason: Error) => void }>()

  constructor() {
    this.worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
      const task = this.pending.get(event.data.id)
      if (!task) return
      this.pending.delete(event.data.id)
      if (event.data.error) task.reject(new Error(event.data.error))
      else task.resolve(event.data)
    })
  }

  private request(message: { sql?: string; bind?: BindableValue[]; action?: 'put-image'|'get-image'; path?: string; data?: string }) {
    const id = crypto.randomUUID()
    return new Promise<WorkerReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, ...message })
    })
  }

  execute(sql: string, bind: BindableValue[] = []) { return this.request({ sql, bind }) }
  async putImage(path:string,data:string){await this.request({action:'put-image',path,data})}
  async getImage(path:string){const result=await this.request({action:'get-image',path});return String(result.rows?.[0]??'')}

  async queueOperation(entityType: string, operation: string, payload: unknown) {
    const id = crypto.randomUUID(), idempotencyKey = crypto.randomUUID(), timestamp = new Date().toISOString()
    await this.execute('INSERT INTO pending_operations(id,idempotency_key,entity_type,operation,payload,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [id, idempotencyKey, entityType, operation, JSON.stringify(payload), 'PENDING_UPLOAD', timestamp, timestamp])
    return { id, idempotencyKey }
  }

  async setCheckpoint(key: string, value: string) {
    await this.execute('INSERT INTO local_sync_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP', [key, value])
  }

  async checkpoint(key:string){const result=await this.execute('SELECT value FROM local_sync_state WHERE key=?',[key]);return (result.rows?.[0] as {value:string}|undefined)?.value}
  async pendingOperations(){const result=await this.execute("SELECT id,idempotency_key,entity_type,operation,payload,retry_count FROM pending_operations WHERE state IN ('PENDING_UPLOAD','ERROR') ORDER BY created_at LIMIT 100");return result.rows||[]}
  async operationState(id:string,state:'SYNCED'|'ERROR',error?:string){await this.execute('UPDATE pending_operations SET state=?,last_error=?,retry_count=retry_count+CASE WHEN ? IS NULL THEN 0 ELSE 1 END,updated_at=CURRENT_TIMESTAMP WHERE id=?',[state,error||null,error||null,id])}
}
