import { LocalSqlite } from './local-sqlite'
import { dataUrlToBytes, imageStore, sha256Hex } from './image-store'
import type { Category, Order, Product, Session, Subcategory, Vendor } from './types'
export type PendingOperation={id:string;idempotency_key:string;entity_type:string;operation:string;payload:string;retry_count:number}
export interface CatalogueStorage {
  products(): Promise<Product[]>
  archivedProducts(): Promise<Product[]>
  deleteProduct(id: string): Promise<void>
  archiveProduct(id: string): Promise<void>
  restoreProduct(id: string): Promise<void>
  updateProduct(x: Product): Promise<void>
  hasLocalReplica(): Promise<boolean>
  saveProduct(x: Product, queue?: boolean): Promise<void>
  /** Runs many writes as one database transaction (bulk catalogue downloads). */
  bulk<T>(work: () => Promise<T>): Promise<T>
  categories(): Promise<Category[]>
  archivedCategories(): Promise<Category[]>
  canDeleteCategory(id: string): Promise<{ allowed: boolean; productCount: number }>
  canArchiveCategory(id: string): Promise<{ allowed: boolean; productCount: number }>
  deleteCategory(id: string): Promise<{ ok: boolean; reason?: string }>
  archiveCategory(id: string): Promise<{ ok: boolean; reason?: string }>
  restoreCategory(id: string): Promise<void>
  updateCategory(x: Category): Promise<void>
  saveCategory(x: Category): Promise<void>
  subcategories(): Promise<Subcategory[]>
  archivedSubcategories(): Promise<Subcategory[]>
  canDeleteSubcategory(id: string): Promise<{ allowed: boolean; productCount: number }>
  canArchiveSubcategory(id: string): Promise<{ allowed: boolean; productCount: number }>
  deleteSubcategory(id: string): Promise<{ ok: boolean; reason?: string }>
  archiveSubcategory(id: string): Promise<{ ok: boolean; reason?: string }>
  restoreSubcategory(id: string): Promise<void>
  updateSubcategory(x: Subcategory): Promise<void>
  saveSubcategory(x: Subcategory): Promise<void>
  vendors(): Promise<Vendor[]>
  archivedVendors(): Promise<Vendor[]>
  deleteVendor(id: string): Promise<void>
  archiveVendor(id: string): Promise<void>
  restoreVendor(id: string): Promise<void>
  updateVendor(x: Vendor): Promise<void>
  saveVendor(x: Vendor): Promise<void>
  orders(): Promise<Order[]>
  /** Orders created on this device whose upload has not finished yet. They are never deleted, merged or hidden. */
  pendingOrderIds(): Promise<Set<string>>
  saveOrder(x: Order): Promise<void>
  session(): Promise<Session | null>
  saveSession(x: Session): Promise<void>
  clearSession(): Promise<void>
  storageBytes(): Promise<number>
  syncCheckpoint(): Promise<number>
  setSyncCheckpoint(x: number): Promise<void>
  pendingOperations(): Promise<PendingOperation[]>
  /** Designs kept on this device because a different cloud design already uses their code. Never uploaded or deleted automatically. */
  heldBackProducts(): Promise<Product[]>
  /** One design on this device by id (active designs only), even when the catalogue hides it behind a same-code design. */
  productRecord(id: string): Promise<Product | null>
  holdBackProduct(id: string, cloudId: string): Promise<void>
  /** How many designs were found at start-up that had never reached the cloud and were put back in the upload queue. */
  requeuedAtStartup(): Promise<number>
  /** Everything still waiting in the upload queue (not capped like pendingOperations). */
  pendingOperationCount(): Promise<number>
  /** Designs on this device whose photos or details have not reached the cloud yet. Wiping the device would lose them. */
  unsentDesignCount(): Promise<number>
  completeOperation(id: string, error?: string): Promise<void>
  clearPendingOperations(): Promise<void>
  remapCategoryId(from: string, to: string): Promise<void>
  remapSubcategoryId(from: string, to: string): Promise<void>
  remapProductId(fromId: string, toId: string, updated: Product): Promise<void>
  remapVendorId(fromId: string, toId: string, updated: Vendor): Promise<void>
  remapOrderId(fromId: string, toId: string, updated: unknown): Promise<void>
  applyRemoteChange(x: { entityType: string; entityId: string; operation: string; payload: unknown }): Promise<void>
  resetLocalData(): Promise<void>
}
class SqliteOpfsStorage implements CatalogueStorage {
 private db=new LocalSqlite();private requeued=0;private ready=this.bootstrap().then(()=>this.requeueUnsentProducts())
 // Design code -> product ids, kept in memory so saving a product never re-reads the whole catalogue
 // (the old per-save scan made a 10,000-product download quadratic).
 private codeIndex:Map<string,Set<string>>|null=null
 private codeOfId=new Map<string,string>()
 // Designs that exist only on this device but have nothing waiting in the upload queue. An older app version erased
 // failed uploads at start-up (for example while the device was signed out), which left such designs stranded forever:
 // on screen, but never sent to the cloud. They are put back in the queue here; designs held back for a code clash are
 // left alone. Operations that ran out of retries get a fresh set, once per app start.
 private async requeueUnsentProducts(){
  try{
   if(!this.db.isAvailable())return
   await this.db.execute("UPDATE pending_operations SET retry_count=0,state='PENDING_UPLOAD' WHERE entity_type='product' AND operation='UPSERT' AND retry_count>=25")
   const rows=await this.db.execute("SELECT id FROM local_entities WHERE entity_type='product' AND deleted=0 AND json_extract(payload,'$.heldBack') IS NULL AND (COALESCE(json_extract(payload,'$.gridImageKey'),'')='' OR COALESCE(json_extract(payload,'$.detailImageKey'),'')='')")
   if(!rows.rows?.length)return
   const queued=new Set(((await this.db.execute("SELECT json_extract(payload,'$.id') id FROM pending_operations WHERE entity_type='product' AND operation IN ('UPSERT','RESTORE')")).rows||[]).map(r=>String((r as {id:string|null}).id||'')))
   for(const r of rows.rows as {id:string}[]){
    if(queued.has(r.id))continue
    await this.db.queueOperation('product','UPSERT',{id:r.id})
    this.requeued++
   }
  }catch(error){console.warn('Could not re-queue designs waiting to upload:',error)}
 }
 async pendingOperationCount(){await this.ready;const r=await this.db.execute("SELECT COUNT(*) n FROM pending_operations WHERE state IN ('PENDING_UPLOAD','ERROR')");return Number((r.rows?.[0] as {n:number}|undefined)?.n||0)}
 async unsentDesignCount(){await this.ready;const r=await this.db.execute("SELECT COUNT(*) n FROM local_entities WHERE entity_type='product' AND (COALESCE(json_extract(payload,'$.gridImageKey'),'')='' OR COALESCE(json_extract(payload,'$.detailImageKey'),'')='' OR json_extract(payload,'$.syncState')!='SYNCED')");return Number((r.rows?.[0] as {n:number}|undefined)?.n||0)}
 async requeuedAtStartup(){await this.ready;return this.requeued}
 async productRecord(id:string){await this.ready;const row=(await this.db.execute("SELECT payload FROM local_entities WHERE entity_type='product' AND id=? AND deleted=0",[id])).rows?.[0] as {payload:string}|undefined;return row?JSON.parse(row.payload) as Product:null}
 async heldBackProducts(){await this.ready;const x=await this.db.execute("SELECT payload FROM local_entities WHERE entity_type='product' AND deleted=0 AND json_extract(payload,'$.heldBack') IS NOT NULL ORDER BY updated_at DESC");return(x.rows||[]).map(r=>JSON.parse((r as {payload:string}).payload) as Product)}
 async holdBackProduct(id:string,cloudId:string){
  await this.ready
  const row=(await this.db.execute("SELECT payload FROM local_entities WHERE entity_type='product' AND id=?",[id])).rows?.[0] as {payload:string}|undefined
  if(!row)return
  const p=JSON.parse(row.payload) as Product
  await this.db.execute('UPDATE local_entities SET payload=?,updated_at=CURRENT_TIMESTAMP WHERE entity_type=? AND id=?',[JSON.stringify({...p,heldBack:{cloudId,at:new Date().toISOString()}}),'product',id])
 }
 private async productCodes(){
  if(!this.codeIndex){
   const rows=await this.db.execute("SELECT id,json_extract(payload,'$.designCode') code FROM local_entities WHERE entity_type='product' AND deleted=0")
   const index=new Map<string,Set<string>>();this.codeOfId.clear()
   for(const r of (rows.rows||[]) as {id:string;code:string|null}[]){
    const code=String(r.code||'').trim().toLowerCase();if(!code)continue
    let ids=index.get(code);if(!ids){ids=new Set();index.set(code,ids)}
    ids.add(r.id);this.codeOfId.set(r.id,code)
   }
   this.codeIndex=index
  }
  return this.codeIndex
 }
 private forgetProductCode(id:string){
  const code=this.codeOfId.get(id);if(code===undefined)return
  this.codeOfId.delete(id);const ids=this.codeIndex?.get(code);if(ids){ids.delete(id);if(!ids.size)this.codeIndex!.delete(code)}
 }
 // Same idea for vendors (name+address) and orders (order number), which also used to re-read their whole table on
 // every save — a first download with thousands of past orders slowed down quadratically.
 private keyIndexes=new Map<string,{byKey:Map<string,Set<string>>;keyOf:Map<string,string>}>()
 private async keyIndex(type:'vendor'|'order'){
  let index=this.keyIndexes.get(type)
  if(!index){
   const sql=type==='vendor'
    ?"SELECT id,lower(trim(json_extract(payload,'$.name')))||'|'||lower(trim(json_extract(payload,'$.address'))) k FROM local_entities WHERE entity_type='vendor' AND deleted=0"
    :"SELECT id,CAST(COALESCE(NULLIF(json_extract(payload,'$.orderNumber'),0),json_extract(payload,'$.order_number'),0) AS INTEGER) k FROM local_entities WHERE entity_type='order' AND deleted=0"
   const rows=await this.db.execute(sql)
   index={byKey:new Map(),keyOf:new Map()}
   for(const r of (rows.rows||[]) as {id:string;k:string|number|null}[]){
    const k=r.k===null||r.k===undefined?'':String(r.k);if(!k||k==='0'||k==='|')continue
    let ids=index.byKey.get(k);if(!ids){ids=new Set();index.byKey.set(k,ids)}
    ids.add(r.id);index.keyOf.set(r.id,k)
   }
   this.keyIndexes.set(type,index)
  }
  return index
 }
 private forgetKey(type:string,id:string){
  const index=this.keyIndexes.get(type);if(!index)return
  const k=index.keyOf.get(id);if(k===undefined)return
  index.keyOf.delete(id);const ids=index.byKey.get(k);if(ids){ids.delete(id);if(!ids.size)index.byKey.delete(k)}
 }
 private setKey(type:string,id:string,k:string){
  const index=this.keyIndexes.get(type);if(!index)return
  this.forgetKey(type,id);if(!k||k==='0'||k==='|')return
  let ids=index.byKey.get(k);if(!ids){ids=new Set();index.byKey.set(k,ids)}
  ids.add(id);index.keyOf.set(id,k)
 }
 async pendingOrderIds(){
  await this.ready
  const rows=await this.db.execute("SELECT json_extract(payload,'$.id') id FROM pending_operations WHERE entity_type='presentation'")
  return new Set(((rows.rows||[]) as {id:string|null}[]).map(r=>String(r.id||'')).filter(Boolean))
 }
 private bulkDepth=0
 async bulk<T>(work:()=>Promise<T>):Promise<T>{
  await this.ready
  if(this.bulkDepth++===0)await this.db.execute('BEGIN').catch(()=>{})
  try{return await work()}
  finally{if(--this.bulkDepth===0)await this.db.execute('COMMIT').catch(()=>{})}
 }
 private async bootstrap(){if(typeof navigator!=='undefined'&&'storage' in navigator&&typeof navigator.storage.persist==='function'){void navigator.storage.persist().catch(()=>{})};if(!this.db.isAvailable())return;try{await this.db.execute('CREATE TABLE IF NOT EXISTS local_entities(entity_type TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(entity_type,id))');if(await this.db.checkpoint('storage_schema_version')!=='5'){await this.db.execute("DELETE FROM local_entities WHERE (entity_type='product' AND id IN ('p1','p2')) OR (entity_type='category' AND id='rings') OR (entity_type='subcategory' AND id='solitaire') OR (entity_type='vendor' AND id='v1')");await this.db.setCheckpoint('storage_schema_version','5')};const pending=await this.db.execute("SELECT id,entity_type,operation,payload FROM pending_operations");for(const op of (pending.rows||[]) as {id:string;entity_type:string;operation:string;payload:string}[]){if(op.entity_type==='product'){try{const parsed=JSON.parse(op.payload) as {id?:string};if(parsed?.id){if(op.operation==='ARCHIVE'){const check=await this.db.execute("SELECT id FROM local_entities WHERE entity_type='product' AND id=?",[parsed.id]);if(!check.rows||check.rows.length===0){await this.db.execute("DELETE FROM pending_operations WHERE id=?",[op.id])}}else{const check=await this.db.execute("SELECT id FROM local_entities WHERE entity_type='product' AND id=? AND deleted=0",[parsed.id]);if(!check.rows||check.rows.length===0){await this.db.execute("DELETE FROM pending_operations WHERE id=?",[op.id])}}}}catch{await this.db.execute("DELETE FROM pending_operations WHERE id=?",[op.id])}}};const vRows=await this.db.execute("SELECT id,payload FROM local_entities WHERE entity_type='vendor' AND deleted=0");const seenV=new Set<string>();for(const r of (vRows.rows||[]) as {id:string;payload:string}[]){try{const v=JSON.parse(r.payload) as Vendor;const k=`${(v.name||'').trim().toLowerCase()}|${(v.address||'').trim().toLowerCase()}`;if(seenV.has(k)){await this.db.execute("DELETE FROM local_entities WHERE entity_type='vendor' AND id=?",[r.id]);await this.db.execute("DELETE FROM pending_operations WHERE entity_type='vendor' AND id=?",[r.id])}else{seenV.add(k)}}catch{await this.db.execute("DELETE FROM local_entities WHERE entity_type='vendor' AND id=?",[r.id])}};const pendingOrders=new Set(((await this.db.execute("SELECT json_extract(payload,'$.id') id FROM pending_operations WHERE entity_type='presentation'")).rows||[]).map(r=>String((r as {id:string|null}).id||'')));const oRows=await this.db.execute("SELECT id,payload FROM local_entities WHERE entity_type='order' AND deleted=0");const seenOrders=new Map<number,{id:string;hasItems:boolean}>();for(const r of (oRows.rows||[]) as {id:string;payload:string}[]){if(pendingOrders.has(r.id))continue;try{const o=JSON.parse(r.payload) as Order&{order_number?:number};const num=Number(o.orderNumber||o.order_number||0);const hasItems=Array.isArray(o.items)&&o.items.length>0;if(num>0){if(seenOrders.has(num)){const prev=seenOrders.get(num)!;if(hasItems&&!prev.hasItems){await this.db.execute("DELETE FROM local_entities WHERE entity_type='order' AND id=?",[prev.id]);seenOrders.set(num,{id:r.id,hasItems})}else{await this.db.execute("DELETE FROM local_entities WHERE entity_type='order' AND id=?",[r.id])}}else{seenOrders.set(num,{id:r.id,hasItems})}}}catch{/* ignore */}}}catch{/* ignore in test runner */}}
 private async save(type:string,id:string,value:unknown){
  if(type==='product'){
   const prod=value as Product
   if(prod.designCode){
    // One design code = one product on this device: drop any other record carrying the same code.
    const index=await this.productCodes(),code=prod.designCode.trim().toLowerCase()
    if(this.codeOfId.get(id)!==code)this.forgetProductCode(id)
    const ids=index.get(code)
    // A cloud design and a design that exists only on this device (not uploaded yet, or held back for this very clash)
    // never remove each other: both are kept, the catalogue shows the cloud one, and the device's design is listed in the
    // Storage tab for a decision. Two records of the same kind with one code are still merged as before.
    const incomingLocal=prod.syncState!=='SYNCED'||!!prod.heldBack
    if(ids)for(const other of [...ids])if(other!==id){
     const o=(await this.db.execute("SELECT json_extract(payload,'$.syncState') s,json_extract(payload,'$.heldBack') h FROM local_entities WHERE entity_type='product' AND id=?",[other])).rows?.[0] as {s:string|null;h:string|null}|undefined
     if(o&&(!!o.h||o.s!=='SYNCED')!==incomingLocal)continue
     await this.db.execute("DELETE FROM local_entities WHERE entity_type='product' AND id=?",[other]);ids.delete(other);this.codeOfId.delete(other)
    }
    if(ids)ids.add(id);else index.set(code,new Set([id]))
    this.codeOfId.set(id,code)
   }
  }
  if(type==='vendor'){
   const v=value as Vendor
   if(v.name&&v.address){
    // One name+address = one vendor on this device.
    const normKey=`${v.name.trim().toLowerCase()}|${v.address.trim().toLowerCase()}`
    const index=await this.keyIndex('vendor')
    for(const other of [...(index.byKey.get(normKey)||[])]){
     if(other===id)continue
     await this.db.execute("DELETE FROM local_entities WHERE entity_type='vendor' AND id=?",[other])
     this.forgetKey('vendor',other)
    }
    this.setKey('vendor',id,normKey)
   }
  }
  if(type==='order'){
   const ord=value as Order
   const ordNum=Number(ord.orderNumber||(ord as unknown as Record<string,unknown>).order_number||0)
   if(ordNum>0){
    // Clean up stale duplicates of an order number — but never touch an order that is still waiting to upload, and never
    // let a waiting order remove a synced one. Two iPads working offline can pick the same number; both orders are kept
    // and the cloud gives the waiting one its final number when it syncs.
    const index=await this.keyIndex('order'),others=[...(index.byKey.get(String(ordNum))||[])].filter(other=>other!==id)
    if(others.length){
     const pending=await this.pendingOrderIds()
     if(!pending.has(id))for(const other of others){
      if(pending.has(other))continue
      await this.db.execute("DELETE FROM local_entities WHERE entity_type='order' AND id=?",[other])
      this.forgetKey('order',other)
     }
    }
   }
   this.setKey('order',id,ordNum>0?String(ordNum):'')
  }
  await this.db.execute('INSERT INTO local_entities(entity_type,id,payload,deleted,updated_at) VALUES(?,?,?,0,CURRENT_TIMESTAMP) ON CONFLICT(entity_type,id) DO UPDATE SET payload=excluded.payload,deleted=0,updated_at=CURRENT_TIMESTAMP',[type,id,JSON.stringify(value)])
 }
 private async values<T>(type:string){await this.ready;const x=await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND deleted=0 ORDER BY updated_at',[type]);return(x.rows||[]).map(r=>JSON.parse((r as {payload:string}).payload) as T)}
 private async persistProduct(x:Product,queue:boolean){
  // Editing a held-back design sends it through the code check again.
  let record:Product=queue&&x.heldBack?{...x,heldBack:undefined}:x
  const hasGrid=(x.gridImage||'').startsWith('data:'),hasDetail=(x.detailImage||'').startsWith('data:')
  if(hasGrid||hasDetail){
   // A photo taken/chosen on this device. The pictures go to the image store as real files (thumbnail, 600px upload
   // source, high-res); the product record keeps only their checksums, never the picture itself.
   const grid=dataUrlToBytes(hasGrid?x.gridImage:x.detailImage).bytes,detail=dataUrlToBytes(hasDetail?x.detailImage:x.gridImage).bytes
   record={...record,gridImage:'',detailImage:'',gridImageKey:undefined,detailImageKey:undefined,gridImageChecksum:await sha256Hex(grid),detailImageChecksum:await sha256Hex(detail),gridImageSizeBytes:grid.length,detailImageSizeBytes:detail.length}
   await imageStore.saveLocal(record,grid,detail)
  }
  await this.save('product',x.id,record);
  if(queue&&x.syncState!=='SYNCED'){
   await this.db.queueOperation('product','UPSERT',{id:x.id});
  }
 }
  async products(): Promise<Product[]> {
    const items = await this.values<Product>('product')
    const byCode = new Map<string, Product>()
    for (const item of items) {
      const key = item.designCode.trim().toLowerCase()
      const curr = byCode.get(key)
      if (!curr) { byCode.set(key, item) }
      else if (curr.syncState !== 'SYNCED' && item.syncState === 'SYNCED') { byCode.set(key, item) }
    }
    return Array.from(byCode.values())
  }
  async archivedProducts(): Promise<Product[]> {
    await this.ready
    const x = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND deleted=1 ORDER BY updated_at DESC', ['product'])
    return (x.rows || []).map(r => JSON.parse((r as { payload: string }).payload) as Product)
  }
  async deleteProduct(id: string): Promise<void> {
    await this.ready
    const res = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND id=?', ['product', id])
    const row = res.rows?.[0] as { payload: string } | undefined
    if (row) {
      const p = JSON.parse(row.payload) as Product
      await this.db.execute('DELETE FROM local_entities WHERE entity_type=? AND id=?', ['product', id])
      this.forgetProductCode(id)
      await imageStore.removeProduct(id)
      await this.db.queueOperation('product', 'DELETE', { id, gridImageKey: p.gridImageKey, detailImageKey: p.detailImageKey })
    }
  }
  async archiveProduct(id: string): Promise<void> {
    return this.deleteProduct(id)
  }
  async restoreProduct(id: string): Promise<void> {
    await this.ready
    const res = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND id=?', ['product', id])
    const row = res.rows?.[0] as { payload: string } | undefined
    if (row) {
      const p = JSON.parse(row.payload) as Product
      p.deleted = false
      if (!p.gridImageKey || !p.detailImageKey) {
        p.syncState = 'PENDING_UPLOAD'
      }
      await this.db.execute('UPDATE local_entities SET payload=?, deleted=0, updated_at=CURRENT_TIMESTAMP WHERE entity_type=? AND id=?', [JSON.stringify(p), 'product', id])
      await this.db.queueOperation('product', 'RESTORE', { id })
      if (!p.gridImageKey || !p.detailImageKey) {
        await this.db.queueOperation('product', 'UPSERT', { id })
      }
    }
  }
  async updateProduct(product: Product): Promise<void> {
    await this.ready
    await this.persistProduct({ ...product, syncState: 'PENDING_UPLOAD' }, true)
  }
 async hasLocalReplica(){await this.ready;const result=await this.db.execute("SELECT COUNT(*) count FROM local_entities WHERE entity_type='product' AND deleted=0");return Number((result.rows?.[0] as {count:number}|undefined)?.count||0)>0}
  async categories(): Promise<Category[]> {
    return (await this.values<Category>('category')).filter(x => x.active)
  }
  async archivedCategories(): Promise<Category[]> {
    await this.ready
    const x = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND deleted=1 ORDER BY updated_at DESC', ['category'])
    return (x.rows || []).map(r => JSON.parse((r as { payload: string }).payload) as Category)
  }
  async canDeleteCategory(id: string): Promise<{ allowed: boolean; productCount: number }> {
    await this.ready
    const activeProds = await this.products()
    const count = activeProds.filter(p => !p.deleted && p.categoryId === id).length
    return { allowed: count === 0, productCount: count }
  }
  async canArchiveCategory(id: string): Promise<{ allowed: boolean; productCount: number }> {
    return this.canDeleteCategory(id)
  }
  async deleteCategory(id: string): Promise<{ ok: boolean; reason?: string }> {
    await this.ready
    const check = await this.canDeleteCategory(id)
    if (!check.allowed) {
      return { ok: false, reason: `Cannot delete category: It is currently referenced by ${check.productCount} active design(s). Please delete those designs first.` }
    }
    await this.db.execute('DELETE FROM local_entities WHERE entity_type=? AND id=?', ['category', id])
    await this.db.queueOperation('category', 'DELETE', { id })
    return { ok: true }
  }
  async archiveCategory(id: string): Promise<{ ok: boolean; reason?: string }> {
    return this.deleteCategory(id)
  }
  async restoreCategory(id: string): Promise<void> {
    await this.ready
    const res = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND id=?', ['category', id])
    const row = res.rows?.[0] as { payload: string } | undefined
    if (row) {
      const c = JSON.parse(row.payload) as Category
      c.active = true
      await this.db.execute('UPDATE local_entities SET payload=?, deleted=0, updated_at=CURRENT_TIMESTAMP WHERE entity_type=? AND id=?', [JSON.stringify(c), 'category', id])
      await this.db.queueOperation('category', 'RESTORE', { id })
    }
  }
  async updateCategory(category: Category): Promise<void> {
    await this.ready
    await this.save('category', category.id, category)
    await this.db.queueOperation('category', 'UPSERT', category)
  }

  async subcategories(): Promise<Subcategory[]> {
    return (await this.values<Subcategory>('subcategory')).filter(x => x.active)
  }
  async archivedSubcategories(): Promise<Subcategory[]> {
    await this.ready
    const x = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND deleted=1 ORDER BY updated_at DESC', ['subcategory'])
    return (x.rows || []).map(r => JSON.parse((r as { payload: string }).payload) as Subcategory)
  }
  async canDeleteSubcategory(id: string): Promise<{ allowed: boolean; productCount: number }> {
    await this.ready
    const activeProds = await this.products()
    const count = activeProds.filter(p => !p.deleted && p.subcategoryId === id).length
    return { allowed: count === 0, productCount: count }
  }
  async canArchiveSubcategory(id: string): Promise<{ allowed: boolean; productCount: number }> {
    return this.canDeleteSubcategory(id)
  }
  async deleteSubcategory(id: string): Promise<{ ok: boolean; reason?: string }> {
    await this.ready
    const check = await this.canDeleteSubcategory(id)
    if (!check.allowed) {
      return { ok: false, reason: `Cannot delete subcategory: It is currently referenced by ${check.productCount} active design(s). Please delete those designs first.` }
    }
    await this.db.execute('DELETE FROM local_entities WHERE entity_type=? AND id=?', ['subcategory', id])
    await this.db.queueOperation('subcategory', 'DELETE', { id })
    return { ok: true }
  }
  async archiveSubcategory(id: string): Promise<{ ok: boolean; reason?: string }> {
    return this.deleteSubcategory(id)
  }
  async restoreSubcategory(id: string): Promise<void> {
    await this.ready
    const res = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND id=?', ['subcategory', id])
    const row = res.rows?.[0] as { payload: string } | undefined
    if (row) {
      const s = JSON.parse(row.payload) as Subcategory
      s.active = true
      await this.db.execute('UPDATE local_entities SET payload=?, deleted=0, updated_at=CURRENT_TIMESTAMP WHERE entity_type=? AND id=?', [JSON.stringify(s), 'subcategory', id])
      await this.db.queueOperation('subcategory', 'RESTORE', { id })
    }
  }
  async updateSubcategory(subcategory: Subcategory): Promise<void> {
    await this.ready
    await this.save('subcategory', subcategory.id, subcategory)
    await this.db.queueOperation('subcategory', 'UPSERT', subcategory)
  }

  async vendors(): Promise<Vendor[]> {
    const items = (await this.values<Vendor>('vendor')).filter(x => !x.deleted)
    const byNameAddress = new Map<string, Vendor>()
    for (const v of items) {
      if (!v.name || !v.address) continue
      const key = `${v.name.trim().toLowerCase()}|${v.address.trim().toLowerCase()}`
      if (!byNameAddress.has(key)) {
        byNameAddress.set(key, v)
      }
    }
    return Array.from(byNameAddress.values())
  }
  async archivedVendors(): Promise<Vendor[]> {
    await this.ready
    const x = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND deleted=1 ORDER BY updated_at DESC', ['vendor'])
    return (x.rows || []).map(r => JSON.parse((r as { payload: string }).payload) as Vendor)
  }
  async deleteVendor(id: string): Promise<void> {
    await this.ready
    await this.db.execute('DELETE FROM local_entities WHERE entity_type=? AND id=?', ['vendor', id])
    this.forgetKey('vendor', id)
    await this.db.queueOperation('vendor', 'DELETE', { id })
  }
  async archiveVendor(id: string): Promise<void> {
    return this.deleteVendor(id)
  }
  async restoreVendor(id: string): Promise<void> {
    await this.ready
    const res = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND id=?', ['vendor', id])
    const row = res.rows?.[0] as { payload: string } | undefined
    if (row) {
      const v = JSON.parse(row.payload) as Vendor
      v.deleted = false
      await this.db.execute('UPDATE local_entities SET payload=?, deleted=0, updated_at=CURRENT_TIMESTAMP WHERE entity_type=? AND id=?', [JSON.stringify(v), 'vendor', id])
      await this.db.queueOperation('vendor', 'RESTORE', { id })
    }
  }
  async updateVendor(vendor: Vendor): Promise<void> {
    await this.ready
    await this.save('vendor', vendor.id, { ...vendor, deleted: false })
    await this.db.queueOperation('vendor', 'UPSERT', vendor)
  }
  async orders(): Promise<Order[]> {
    const raw = await this.values<Record<string, unknown>>('order')
    const mapped = raw.map(o => {
      const vRaw = (o.vendor as Record<string, unknown> | undefined) || {}
      const vendorName = String(vRaw.name || o.vendor_name_snapshot || o.vendorName || 'Unknown Vendor')
      const vendorAddress = String(vRaw.address || o.vendor_address_snapshot || o.vendorAddress || '')
      const vendorCity = String(vRaw.city || o.vendor_city_snapshot || o.vendorCity || '')
      const vendorType = String(vRaw.type || o.vendor_type_snapshot || o.vendorType || 'WHOLESALE') as Vendor['type']
      const vendorId = String(vRaw.id || o.vendor_id || '')
      const vendor: Vendor = { id: vendorId, name: vendorName, address: vendorAddress, city: vendorCity, type: vendorType }

      const orderNumber = Number(o.orderNumber || o.order_number || 0)
      const rawItems = Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : []
      const itemsList = rawItems.map(i => ({
        productId: String(i.productId || i.product_id || ''),
        serialNumber: Number(i.serialNumber || i.serial_number || 1),
        designCode: String(i.designCode || i.design_code_snapshot || i.designCodeSnapshot || ''),
        category: String(i.category || i.category_snapshot || i.categorySnapshot || ''),
        subcategory: String(i.subcategory || i.subcategory_snapshot || i.subcategorySnapshot || ''),
        weightMg: Number(i.weightMg || i.weight_mg_snapshot || i.weightMgSnapshot || 0),
        quantity: Number(i.quantity || 1),
        remark: String(i.remark || ''),
        image: String(i.image || '')
      }))
      const salesperson = String(o.salesperson || o.salesperson_id || 'Salesperson')
      const generatedAt = String(o.generatedAt || o.generated_at || o.createdAt || new Date().toISOString())
      const createdAt = String(o.createdAt || o.generatedAt || o.generated_at || new Date().toISOString())

      const rawReps = Array.isArray(o.representatives) ? (o.representatives as Record<string, unknown>[]) : []
      const representatives = rawReps.map(r => ({
        name: String(r.name || '').trim(),
        phone: String(r.phone || '').trim()
      })).filter(r => r.name || r.phone)

      return {
        ...o,
        id: String(o.id),
        orderNumber,
        vendor,
        representatives: representatives.length ? representatives : undefined,
        items: itemsList,
        salesperson,
        status: (o.status as Order['status']) || 'FINALIZED',
        createdAt,
        generatedAt
      } as Order
    })

    const byId = new Map<string, Order>()
    for (const ord of mapped) {
      const existing = byId.get(ord.id)
      if (!existing) {
        byId.set(ord.id, ord)
      } else if ((!existing.items || existing.items.length === 0) && ord.items && ord.items.length > 0) {
        byId.set(ord.id, ord)
      }
    }

    const pending = await this.pendingOrderIds()
    const byNumber = new Map<number, Order>()
    const unnumbered: Order[] = []
    for (const ord of byId.values()) {
      // An order still waiting to upload is always listed, even if another order shows the same number for now.
      if (pending.has(ord.id)) { unnumbered.push(ord); continue }
      if (ord.orderNumber && ord.orderNumber > 0) {
        const existing = byNumber.get(ord.orderNumber)
        if (!existing) {
          byNumber.set(ord.orderNumber, ord)
        } else {
          const existingScore = (existing.items?.length || 0) * 10 + (existing.vendor?.name ? 1 : 0)
          const newScore = (ord.items?.length || 0) * 10 + (ord.vendor?.name ? 1 : 0)
          if (newScore > existingScore) {
            byNumber.set(ord.orderNumber, ord)
          }
        }
      } else {
        unnumbered.push(ord)
      }
    }

    const deduped = [...Array.from(byNumber.values()), ...unnumbered]
    deduped.sort((a, b) => (b.orderNumber || 0) - (a.orderNumber || 0))
    return deduped
  }
 async session(){return(await this.values<Session>('offline-authorization'))[0]||null}
 async saveCategory(x:Category){await this.ready;await this.save('category',x.id,x);await this.db.queueOperation('category','UPSERT',x)} async saveSubcategory(x:Subcategory){await this.ready;await this.save('subcategory',x.id,x);await this.db.queueOperation('subcategory','UPSERT',x)} async saveVendor(x:Vendor){await this.ready;await this.save('vendor',x.id,x);await this.db.queueOperation('vendor','UPSERT',x)} async saveProduct(x:Product,queue=x.syncState!=='SYNCED'){await this.ready;await this.persistProduct(x,queue)} async saveOrder(x:Order){await this.ready;await this.save('order',x.id,x);await this.db.queueOperation('presentation','FINALIZE',x)}
 async saveSession(x:Session){await this.ready;await this.save('offline-authorization',x.userId,x);await this.db.setCheckpoint('offline_authorization_expires_at',x.offlineAuthorizationExpiresAt)} async clearSession(){await this.ready;await this.db.execute("UPDATE local_entities SET deleted=1,updated_at=CURRENT_TIMESTAMP WHERE entity_type='offline-authorization'")} async storageBytes(){return (await imageStore.usage())?.usage||0}
 async syncCheckpoint(){await this.ready;return Number(await this.db.checkpoint('sync_checkpoint')||0)} async setSyncCheckpoint(x:number){await this.ready;await this.db.setCheckpoint('sync_checkpoint',String(x))}
  async pendingOperations() {
    await this.ready;
    const list = (await this.db.pendingOperations()) as PendingOperation[];
    const valid: PendingOperation[] = [];
    for (const op of list) {
      try {
        const parsed = JSON.parse(op.payload) as { id?: string };
        if (parsed?.id && ['product', 'vendor', 'category', 'subcategory'].includes(op.entity_type)) {
          if (op.operation === 'ARCHIVE') {
            const check = await this.db.execute('SELECT id FROM local_entities WHERE entity_type=? AND id=?', [op.entity_type, parsed.id]);
            if (!check.rows || check.rows.length === 0) {
              await this.db.execute('DELETE FROM pending_operations WHERE id=?', [op.id]);
              continue;
            }
          } else if (op.operation === 'RESTORE') {
            const check = await this.db.execute('SELECT id FROM local_entities WHERE entity_type=? AND id=?', [op.entity_type, parsed.id]);
            if (!check.rows || check.rows.length === 0) {
              await this.db.execute('DELETE FROM pending_operations WHERE id=?', [op.id]);
              continue;
            }
          } else {
            const check = await this.db.execute('SELECT id FROM local_entities WHERE entity_type=? AND id=? AND deleted=0', [op.entity_type, parsed.id]);
            if (!check.rows || check.rows.length === 0) {
              await this.db.execute('DELETE FROM pending_operations WHERE id=?', [op.id]);
              continue;
            }
          }
        }
      } catch {
        await this.db.execute('DELETE FROM pending_operations WHERE id=?', [op.id]);
        continue;
      }
      valid.push(op);
    }
    return valid;
  }
 async completeOperation(id:string,error?:string){await this.ready;await this.db.operationState(id,error?'ERROR':'SYNCED',error)}
 async clearPendingOperations(){await this.ready;await this.db.execute('DELETE FROM pending_operations')}
 async remapCategoryId(from:string,to:string){if(from===to)return;await this.ready;const category=(await this.values<Category>('category')).find(item=>item.id===from);if(category){await this.save('category',to,{...category,id:to});await this.db.execute('UPDATE local_entities SET deleted=1 WHERE entity_type=? AND id=?',['category',from])}for(const subcategory of await this.subcategories())if(subcategory.categoryId===from)await this.save('subcategory',subcategory.id,{...subcategory,categoryId:to});for(const product of await this.products())if(product.categoryId===from)await this.save('product',product.id,{...product,categoryId:to})}
 async remapSubcategoryId(from:string,to:string){if(from===to)return;await this.ready;const subcategory=(await this.subcategories()).find(item=>item.id===from);if(subcategory){await this.save('subcategory',to,{...subcategory,id:to});await this.db.execute('UPDATE local_entities SET deleted=1 WHERE entity_type=? AND id=?',['subcategory',from])}for(const product of await this.products())if(product.subcategoryId===from)await this.save('product',product.id,{...product,subcategoryId:to})}
 async remapProductId(fromId:string,toId:string,updated:Product){
  await this.ready;
  if(fromId!==toId){
   await this.db.execute("DELETE FROM local_entities WHERE entity_type='product' AND id=?",[fromId])
   await this.db.execute("DELETE FROM pending_operations WHERE entity_type='product' AND payload LIKE ?",[`%"id":"${fromId}"%`])
   this.forgetProductCode(fromId)
  }
  await this.persistProduct(updated,false)
 }
 async remapVendorId(fromId:string,toId:string,updated:Vendor){
  if(fromId===toId)return;
  await this.ready;
  await this.db.execute("DELETE FROM local_entities WHERE entity_type='vendor' AND id=?",[fromId]);
  this.forgetKey('vendor',fromId);
  await this.db.execute("DELETE FROM pending_operations WHERE entity_type='vendor' AND id=?",[fromId]);
  await this.save('vendor',toId,updated);
  const orderRows=await this.db.execute("SELECT id,payload FROM local_entities WHERE entity_type='order' AND deleted=0");
  for(const r of (orderRows.rows||[]) as {id:string;payload:string}[]){
   try{
    const ord=JSON.parse(r.payload) as Order;
    if(ord.vendor?.id===fromId){
     ord.vendor={...ord.vendor,...updated,id:toId};
     await this.save('order',ord.id,ord);
    }
   }catch{/* ignore */}
  }
 }
 async remapOrderId(fromId:string,toId:string,updated:unknown):Promise<void>{
  if(fromId===toId)return;
  await this.ready;
  await this.db.execute("DELETE FROM local_entities WHERE entity_type='order' AND id=?",[fromId]);
  this.forgetKey('order',fromId);
  await this.db.execute("DELETE FROM pending_operations WHERE entity_type='presentation' AND (payload LIKE ? OR id=?)",[`%"id":"${fromId}"%`,fromId]);
  await this.save('order',toId,updated);
 }
 async applyRemoteChange(x:{entityType:string;entityId:string;operation:string;payload:unknown}){await this.ready;if(x.operation==='ARCHIVE'||x.operation==='DELETE'){if(x.entityType==='product'){this.forgetProductCode(x.entityId);await imageStore.removeProduct(x.entityId)}await this.db.execute('DELETE FROM local_entities WHERE entity_type=? AND id=?',[x.entityType==='presentation'?'order':x.entityType,x.entityId]);this.forgetKey(x.entityType==='presentation'?'order':x.entityType,x.entityId);return}const type=x.entityType==='presentation'?'order':x.entityType;const payload=x.payload as Record<string,unknown>;await this.save(type,x.entityId,{...payload,id:x.entityId})}
 async resetLocalData(): Promise<void> {
  await this.ready
  await this.db.execute("DELETE FROM local_entities WHERE entity_type != 'offline-authorization'")
  await this.db.execute("DELETE FROM pending_operations")
  await this.db.execute("DELETE FROM local_image_metadata")
  await this.db.execute("DELETE FROM storage_accounting")
  await this.db.setCheckpoint('sync_checkpoint', '0')
  this.codeIndex=null;this.codeOfId.clear();this.keyIndexes.clear()
  await imageStore.wipe()
 }
}
export const storage:CatalogueStorage=new SqliteOpfsStorage()
