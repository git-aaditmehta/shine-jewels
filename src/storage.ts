import { LocalSqlite } from './local-sqlite'
import type { Category, Order, Product, Session, Subcategory, Vendor } from './types'
export type PendingOperation={id:string;idempotency_key:string;entity_type:string;operation:string;payload:string;retry_count:number}
export interface CatalogueStorage {
  products(): Promise<Product[]>
  archivedProducts(): Promise<Product[]>
  archiveProduct(id: string): Promise<void>
  restoreProduct(id: string): Promise<void>
  updateProduct(x: Product): Promise<void>
  hasLocalReplica(): Promise<boolean>
  saveProduct(x: Product, queue?: boolean): Promise<void>
  getImage(path: string): Promise<string | null>
  saveImageData(path: string, dataUrl: string): Promise<void>
  hasImage(path: string): Promise<boolean>
  deleteImage(path: string): Promise<void>
  categories(): Promise<Category[]>
  archivedCategories(): Promise<Category[]>
  canArchiveCategory(id: string): Promise<{ allowed: boolean; productCount: number }>
  archiveCategory(id: string): Promise<{ ok: boolean; reason?: string }>
  restoreCategory(id: string): Promise<void>
  updateCategory(x: Category): Promise<void>
  saveCategory(x: Category): Promise<void>
  subcategories(): Promise<Subcategory[]>
  archivedSubcategories(): Promise<Subcategory[]>
  canArchiveSubcategory(id: string): Promise<{ allowed: boolean; productCount: number }>
  archiveSubcategory(id: string): Promise<{ ok: boolean; reason?: string }>
  restoreSubcategory(id: string): Promise<void>
  updateSubcategory(x: Subcategory): Promise<void>
  saveSubcategory(x: Subcategory): Promise<void>
  vendors(): Promise<Vendor[]>
  archivedVendors(): Promise<Vendor[]>
  archiveVendor(id: string): Promise<void>
  restoreVendor(id: string): Promise<void>
  updateVendor(x: Vendor): Promise<void>
  saveVendor(x: Vendor): Promise<void>
  orders(): Promise<Order[]>
  saveOrder(x: Order): Promise<void>
  session(): Promise<Session | null>
  saveSession(x: Session): Promise<void>
  clearSession(): Promise<void>
  storageBytes(): Promise<number>
  syncCheckpoint(): Promise<number>
  setSyncCheckpoint(x: number): Promise<void>
  pendingOperations(): Promise<PendingOperation[]>
  completeOperation(id: string, error?: string): Promise<void>
  clearPendingOperations(): Promise<void>
  remapCategoryId(from: string, to: string): Promise<void>
  remapSubcategoryId(from: string, to: string): Promise<void>
  remapProductId(fromId: string, toId: string, updated: Product): Promise<void>
  remapVendorId(fromId: string, toId: string, updated: Vendor): Promise<void>
  remapOrderId(fromId: string, toId: string, updated: unknown): Promise<void>
  applyRemoteChange(x: { entityType: string; entityId: string; operation: string; payload: unknown }): Promise<void>
  cacheRemoteImage(productId: string, representation: 'grid' | 'detail', url: string, version: number, expectedChecksum?: string, expectedSize?: number): Promise<void>
  resolveDetailImage(product: Product): Promise<string>
}
class SqliteOpfsStorage implements CatalogueStorage {
 private db=new LocalSqlite();private ready=this.bootstrap()
 private imageMemoryCache=new Map<string,string>()
 private cacheImageInMemory(path:string,data:string){
   if(this.imageMemoryCache.size>=250){
     const oldest=this.imageMemoryCache.keys().next().value
     if(oldest)this.imageMemoryCache.delete(oldest)
   }
   this.imageMemoryCache.set(path,data)
 }
 private async bootstrap(){if(!this.db.isAvailable())return;try{await this.db.execute('CREATE TABLE IF NOT EXISTS local_entities(entity_type TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(entity_type,id))');if(await this.db.checkpoint('storage_schema_version')!=='5'){await this.db.execute("DELETE FROM local_entities WHERE (entity_type='product' AND id IN ('p1','p2')) OR (entity_type='category' AND id='rings') OR (entity_type='subcategory' AND id='solitaire') OR (entity_type='vendor' AND id='v1')");await this.db.setCheckpoint('storage_schema_version','5')};await this.db.execute("DELETE FROM pending_operations WHERE state='ERROR'");const pending=await this.db.execute("SELECT id,entity_type,operation,payload FROM pending_operations");for(const op of (pending.rows||[]) as {id:string;entity_type:string;operation:string;payload:string}[]){if(op.entity_type==='product'){try{const parsed=JSON.parse(op.payload) as {id?:string};if(parsed?.id){if(op.operation==='ARCHIVE'){const check=await this.db.execute("SELECT id FROM local_entities WHERE entity_type='product' AND id=?",[parsed.id]);if(!check.rows||check.rows.length===0){await this.db.execute("DELETE FROM pending_operations WHERE id=?",[op.id])}}else{const check=await this.db.execute("SELECT id FROM local_entities WHERE entity_type='product' AND id=? AND deleted=0",[parsed.id]);if(!check.rows||check.rows.length===0){await this.db.execute("DELETE FROM pending_operations WHERE id=?",[op.id])}}}}catch{await this.db.execute("DELETE FROM pending_operations WHERE id=?",[op.id])}}};const vRows=await this.db.execute("SELECT id,payload FROM local_entities WHERE entity_type='vendor' AND deleted=0");const seenV=new Set<string>();for(const r of (vRows.rows||[]) as {id:string;payload:string}[]){try{const v=JSON.parse(r.payload) as Vendor;const k=`${(v.name||'').trim().toLowerCase()}|${(v.address||'').trim().toLowerCase()}`;if(seenV.has(k)){await this.db.execute("DELETE FROM local_entities WHERE entity_type='vendor' AND id=?",[r.id]);await this.db.execute("DELETE FROM pending_operations WHERE entity_type='vendor' AND id=?",[r.id])}else{seenV.add(k)}}catch{await this.db.execute("DELETE FROM local_entities WHERE entity_type='vendor' AND id=?",[r.id])}};const oRows=await this.db.execute("SELECT id,payload FROM local_entities WHERE entity_type='order' AND deleted=0");const seenOrders=new Map<number,{id:string;hasItems:boolean}>();for(const r of (oRows.rows||[]) as {id:string;payload:string}[]){try{const o=JSON.parse(r.payload) as Order&{order_number?:number};const num=Number(o.orderNumber||o.order_number||0);const hasItems=Array.isArray(o.items)&&o.items.length>0;if(num>0){if(seenOrders.has(num)){const prev=seenOrders.get(num)!;if(hasItems&&!prev.hasItems){await this.db.execute("DELETE FROM local_entities WHERE entity_type='order' AND id=?",[prev.id]);seenOrders.set(num,{id:r.id,hasItems})}else{await this.db.execute("DELETE FROM local_entities WHERE entity_type='order' AND id=?",[r.id])}}else{seenOrders.set(num,{id:r.id,hasItems})}}}catch{/* ignore */}}}catch{/* ignore in test runner */}}
 private async save(type:string,id:string,value:unknown){
  if(type==='product'){
   const prod=value as Product
   if(prod.designCode){
    const existingRows=await this.db.execute("SELECT id,payload FROM local_entities WHERE entity_type='product' AND deleted=0")
    for(const r of existingRows.rows||[]){
     const row=r as {id:string;payload:string}
     if(row.id!==id){
      try{
       const p=JSON.parse(row.payload) as Product
       if(p.designCode&&p.designCode.trim().toLowerCase()===prod.designCode.trim().toLowerCase()){
        await this.db.execute("DELETE FROM local_entities WHERE entity_type='product' AND id=?",[row.id])
       }
      }catch{/* ignore parse error */}
     }
    }
   }
  }
  if(type==='vendor'){
   const v=value as Vendor
   if(v.name&&v.address){
    const normKey=`${v.name.trim().toLowerCase()}|${v.address.trim().toLowerCase()}`
    const existingRows=await this.db.execute("SELECT id,payload FROM local_entities WHERE entity_type='vendor' AND deleted=0")
    for(const r of existingRows.rows||[]){
     const row=r as {id:string;payload:string}
     if(row.id!==id){
      try{
       const ev=JSON.parse(row.payload) as Vendor
       if(ev.name&&ev.address&&`${ev.name.trim().toLowerCase()}|${ev.address.trim().toLowerCase()}`===normKey){
        await this.db.execute("DELETE FROM local_entities WHERE entity_type='vendor' AND id=?",[row.id])
        await this.db.execute("DELETE FROM pending_operations WHERE entity_type='vendor' AND id=?",[row.id])
       }
      }catch{/* ignore */}
     }
    }
   }
  }
  if(type==='order'){
   const ord=value as Order
   const ordNum=Number(ord.orderNumber||(ord as unknown as Record<string,unknown>).order_number||0)
   if(ordNum>0){
    const existingRows=await this.db.execute("SELECT id,payload FROM local_entities WHERE entity_type='order' AND deleted=0")
    for(const r of existingRows.rows||[]){
     const row=r as {id:string;payload:string}
     if(row.id!==id){
      try{
       const existing=JSON.parse(row.payload) as Order
       const existingNum=Number(existing.orderNumber||(existing as unknown as Record<string,unknown>).order_number||0)
       if(existingNum===ordNum){
        await this.db.execute("DELETE FROM local_entities WHERE entity_type='order' AND id=?",[row.id])
        await this.db.execute("DELETE FROM pending_operations WHERE entity_type='presentation' AND (payload LIKE ? OR id=?)",[`%"id":"${row.id}"%`,row.id])
       }
      }catch{/* ignore */}
     }
    }
   }
  }
  await this.db.execute('INSERT INTO local_entities(entity_type,id,payload,deleted,updated_at) VALUES(?,?,?,0,CURRENT_TIMESTAMP) ON CONFLICT(entity_type,id) DO UPDATE SET payload=excluded.payload,deleted=0,updated_at=CURRENT_TIMESTAMP',[type,id,JSON.stringify(value)])
 }
 private async values<T>(type:string){await this.ready;const x=await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND deleted=0 ORDER BY updated_at',[type]);return(x.rows||[]).map(r=>JSON.parse((r as {payload:string}).payload) as T)}
 private async persistProduct(x:Product,queue:boolean){
  let gridImage=x.gridImage,detailImage=x.detailImage;
  const grid=`${x.id}-grid-v${x.imageVersion}`,detail=`${x.id}-detail-v${x.imageVersion}`;
  if(x.gridImage.startsWith('data:')){
   this.cacheImageInMemory(grid,x.gridImage);
   await this.db.putImage(grid,x.gridImage);
   gridImage=grid;
  }
  if(x.detailImage.startsWith('data:')){
   this.cacheImageInMemory(detail,x.detailImage);
   await this.db.putImage(detail,x.detailImage);
   detailImage=detail;
  }
  await this.save('product',x.id,{...x,gridImage,detailImage});
  if(queue&&x.syncState!=='SYNCED'){
   await this.db.queueOperation('product','UPSERT',{id:x.id});
  }
 }
  private async resolvePath(path: string, representation: 'grid' | 'detail', key?: string, sizeBytes?: number): Promise<string> {
    if (representation === 'detail' && sizeBytes !== undefined && sizeBytes > 0 && sizeBytes < 1000) {
      key = undefined
    }
    if (path) {
      if (path.startsWith('data:') || path.startsWith('http://') || path.startsWith('https://')) return path
      if (this.imageMemoryCache.has(path)) {
        const cached = this.imageMemoryCache.get(path)!
        this.imageMemoryCache.delete(path)
        this.imageMemoryCache.set(path, cached)
        return cached
      }
      try {
        const data = await this.db.getImage(path)
        if (data && data.startsWith('data:')) {
          this.cacheImageInMemory(path, data)
          return data
        }
      } catch { /* not cached locally */ }
    }
    const r2Base = (import.meta.env.VITE_R2_PUBLIC_BASE_URL || 'https://pub-ddd4389cc31a46b6b365e21911f96e1f.r2.dev').replace(/\/$/, '')
    if (key) return `${r2Base}/${key.split('/').map(encodeURIComponent).join('/')}`
    return ''
  }
  async resolveDetailImage(product: Product): Promise<string> {
    const resolved = await this.resolvePath(product.detailImage, 'detail', product.detailImageKey, product.detailImageSizeBytes)
    if (resolved && (resolved.startsWith('data:') || resolved.startsWith('http://') || resolved.startsWith('https://'))) {
      return resolved
    }
    return product.gridImage || ''
  }
  private async resolveProductImages(items: Product[]): Promise<Product[]> {
    return Promise.all(items.map(async item => {
      const grid = await this.resolvePath(item.gridImage, 'grid', item.gridImageKey, item.gridImageSizeBytes)
      return { ...item, gridImage: grid }
    }))
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
    return this.resolveProductImages(Array.from(byCode.values()))
  }
  async archivedProducts(): Promise<Product[]> {
    await this.ready
    const x = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND deleted=1 ORDER BY updated_at DESC', ['product'])
    const items = (x.rows || []).map(r => JSON.parse((r as { payload: string }).payload) as Product)
    return this.resolveProductImages(items)
  }
  async archiveProduct(id: string): Promise<void> {
    await this.ready
    const res = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND id=?', ['product', id])
    const row = res.rows?.[0] as { payload: string } | undefined
    if (row) {
      const p = JSON.parse(row.payload) as Product
      p.deleted = true
      await this.db.execute('UPDATE local_entities SET payload=?, deleted=1, updated_at=CURRENT_TIMESTAMP WHERE entity_type=? AND id=?', [JSON.stringify(p), 'product', id])
      await this.db.queueOperation('product', 'ARCHIVE', { id })
    }
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
 async getImage(path:string):Promise<string|null>{if(!path)return null;if(path.startsWith('data:'))return path;if(this.imageMemoryCache.has(path))return this.imageMemoryCache.get(path)!;await this.ready;try{const data=await this.db.getImage(path);if(data&&data.startsWith('data:')){this.cacheImageInMemory(path,data);return data}}catch{/* not in local storage */}return null}
 async saveImageData(path:string,dataUrl:string):Promise<void>{if(!path||!dataUrl)return;this.cacheImageInMemory(path,dataUrl);await this.ready;try{await this.db.putImage(path,dataUrl)}catch{/* ignore */}}
 async hasImage(path:string){if(this.imageMemoryCache.has(path))return true;await this.ready;return this.db.hasImage(path)}
 async deleteImage(path:string){this.imageMemoryCache.delete(path);await this.ready;return this.db.deleteImage(path)}
  async categories(): Promise<Category[]> {
    return (await this.values<Category>('category')).filter(x => x.active)
  }
  async archivedCategories(): Promise<Category[]> {
    await this.ready
    const x = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND deleted=1 ORDER BY updated_at DESC', ['category'])
    return (x.rows || []).map(r => JSON.parse((r as { payload: string }).payload) as Category)
  }
  async canArchiveCategory(id: string): Promise<{ allowed: boolean; productCount: number }> {
    await this.ready
    const activeProds = await this.products()
    const count = activeProds.filter(p => !p.deleted && p.categoryId === id).length
    return { allowed: count === 0, productCount: count }
  }
  async archiveCategory(id: string): Promise<{ ok: boolean; reason?: string }> {
    await this.ready
    const check = await this.canArchiveCategory(id)
    if (!check.allowed) {
      return { ok: false, reason: `Cannot archive category: It is currently referenced by ${check.productCount} active design(s). Please reassign or archive those designs first.` }
    }
    const res = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND id=?', ['category', id])
    const row = res.rows?.[0] as { payload: string } | undefined
    if (row) {
      const c = JSON.parse(row.payload) as Category
      c.active = false
      await this.db.execute('UPDATE local_entities SET payload=?, deleted=1, updated_at=CURRENT_TIMESTAMP WHERE entity_type=? AND id=?', [JSON.stringify(c), 'category', id])
      await this.db.queueOperation('category', 'ARCHIVE', { id })
    }
    return { ok: true }
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
  async canArchiveSubcategory(id: string): Promise<{ allowed: boolean; productCount: number }> {
    await this.ready
    const activeProds = await this.products()
    const count = activeProds.filter(p => !p.deleted && p.subcategoryId === id).length
    return { allowed: count === 0, productCount: count }
  }
  async archiveSubcategory(id: string): Promise<{ ok: boolean; reason?: string }> {
    await this.ready
    const check = await this.canArchiveSubcategory(id)
    if (!check.allowed) {
      return { ok: false, reason: `Cannot archive subcategory: It is currently referenced by ${check.productCount} active design(s). Please reassign or archive those designs first.` }
    }
    const res = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND id=?', ['subcategory', id])
    const row = res.rows?.[0] as { payload: string } | undefined
    if (row) {
      const s = JSON.parse(row.payload) as Subcategory
      s.active = false
      await this.db.execute('UPDATE local_entities SET payload=?, deleted=1, updated_at=CURRENT_TIMESTAMP WHERE entity_type=? AND id=?', [JSON.stringify(s), 'subcategory', id])
      await this.db.queueOperation('subcategory', 'ARCHIVE', { id })
    }
    return { ok: true }
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
  async archiveVendor(id: string): Promise<void> {
    await this.ready
    const res = await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND id=?', ['vendor', id])
    const row = res.rows?.[0] as { payload: string } | undefined
    if (row) {
      const v = JSON.parse(row.payload) as Vendor
      v.deleted = true
      await this.db.execute('UPDATE local_entities SET payload=?, deleted=1, updated_at=CURRENT_TIMESTAMP WHERE entity_type=? AND id=?', [JSON.stringify(v), 'vendor', id])
      await this.db.queueOperation('vendor', 'ARCHIVE', { id })
    }
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

      return {
        ...o,
        id: String(o.id),
        orderNumber,
        vendor,
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

    const byNumber = new Map<number, Order>()
    const unnumbered: Order[] = []
    for (const ord of byId.values()) {
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
 async saveSession(x:Session){await this.ready;await this.save('offline-authorization',x.userId,x);await this.db.setCheckpoint('offline_authorization_expires_at',x.offlineAuthorizationExpiresAt)} async clearSession(){await this.ready;await this.db.execute("UPDATE local_entities SET deleted=1,updated_at=CURRENT_TIMESTAMP WHERE entity_type='offline-authorization'")} async storageBytes(){await this.ready;const x=await this.db.execute('SELECT COALESCE(SUM(bytes),0) bytes FROM storage_accounting');return Number((x.rows?.[0] as {bytes:number}|undefined)?.bytes||0)}
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
   const oldGrid=`${fromId}-grid-v${updated.imageVersion}`,newGrid=`${toId}-grid-v${updated.imageVersion}`
   const oldDetail=`${fromId}-detail-v${updated.imageVersion}`,newDetail=`${toId}-detail-v${updated.imageVersion}`
   if(this.imageMemoryCache.has(oldGrid))this.cacheImageInMemory(newGrid,this.imageMemoryCache.get(oldGrid)!)
   if(this.imageMemoryCache.has(oldDetail))this.cacheImageInMemory(newDetail,this.imageMemoryCache.get(oldDetail)!)
  }
  await this.persistProduct(updated,false)
 }
 async remapVendorId(fromId:string,toId:string,updated:Vendor){
  if(fromId===toId)return;
  await this.ready;
  await this.db.execute("DELETE FROM local_entities WHERE entity_type='vendor' AND id=?",[fromId]);
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
  await this.db.execute("DELETE FROM pending_operations WHERE entity_type='presentation' AND (payload LIKE ? OR id=?)",[`%"id":"${fromId}"%`,fromId]);
  await this.save('order',toId,updated);
 }
 async applyRemoteChange(x:{entityType:string;entityId:string;operation:string;payload:unknown}){await this.ready;if(x.operation==='ARCHIVE'||x.operation==='DELETE'){await this.db.execute('UPDATE local_entities SET deleted=1,updated_at=CURRENT_TIMESTAMP WHERE entity_type=? AND id=?',[x.entityType,x.entityId]);return}const type=x.entityType==='presentation'?'order':x.entityType;const payload=x.payload as Record<string,unknown>;await this.save(type,x.entityId,{...payload,id:x.entityId})}
 async cacheRemoteImage(productId:string,representation:'grid'|'detail',url:string,version:number,expectedChecksum?:string,expectedSize?:number){
  const response=await fetch(url)
  if(!response.ok)throw new Error(`Image recovery download failed (${response.status})`)
  const buffer=await response.arrayBuffer()
  if(expectedSize!==undefined&&expectedSize>0&&buffer.byteLength!==expectedSize){
   throw new Error(`Downloaded image size (${buffer.byteLength}) does not match expected size (${expectedSize}).`)
  }
  const hashBuffer=await crypto.subtle.digest('SHA-256',buffer)
  const checksum=Array.from(new Uint8Array(hashBuffer)).map(b=>b.toString(16).padStart(2,'0')).join('')
  if(expectedChecksum&&checksum.toLowerCase()!==expectedChecksum.toLowerCase()){
   throw new Error(`Downloaded image checksum does not match expected checksum.`)
  }
  const contentType=response.headers.get('content-type')||'image/jpeg'
  const bytes=new Uint8Array(buffer)
  let binary=''
  const len=bytes.byteLength
  for(let i=0;i<len;i+=8192){binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+8192,len)))}
  const data=`data:${contentType};base64,${btoa(binary)}`
  const path=`${productId}-${representation}-v${version}`
  this.cacheImageInMemory(path,data)
  await this.db.putImage(path,data)
  await this.db.execute('INSERT INTO local_image_metadata(image_key,product_id,representation,size_bytes,checksum,image_version,local_path,integrity_state,updated_at) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(image_key) DO UPDATE SET size_bytes=excluded.size_bytes,checksum=excluded.checksum,local_path=excluded.local_path,integrity_state=excluded.integrity_state,updated_at=CURRENT_TIMESTAMP',[`${productId}/${representation}/v${version}`,productId,representation,buffer.byteLength,checksum,version,path,'VERIFIED'])
  const result=await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND id=?',['product',productId])
  const record=result.rows?.[0] as {payload:string}|undefined
  if(record){
   const product=JSON.parse(record.payload) as Product
   await this.save('product',productId,{...product,[representation==='grid'?'gridImage':'detailImage']:path})
  }
 }
}
export const storage:CatalogueStorage=new SqliteOpfsStorage()
