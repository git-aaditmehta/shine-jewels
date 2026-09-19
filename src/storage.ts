import { LocalSqlite } from './local-sqlite'
import type { Category, Order, Product, Session, Subcategory, Vendor } from './types'
export type PendingOperation={id:string;idempotency_key:string;entity_type:string;operation:string;payload:string;retry_count:number}
export interface CatalogueStorage { products():Promise<Product[]>;hasLocalReplica():Promise<boolean>;saveProduct(x:Product,queue?:boolean):Promise<void>;hasImage(path:string):Promise<boolean>;deleteImage(path:string):Promise<void>;categories():Promise<Category[]>;saveCategory(x:Category):Promise<void>;subcategories():Promise<Subcategory[]>;saveSubcategory(x:Subcategory):Promise<void>;vendors():Promise<Vendor[]>;saveVendor(x:Vendor):Promise<void>;orders():Promise<Order[]>;saveOrder(x:Order):Promise<void>;session():Promise<Session|null>;saveSession(x:Session):Promise<void>;clearSession():Promise<void>;storageBytes():Promise<number>;syncCheckpoint():Promise<number>;setSyncCheckpoint(x:number):Promise<void>;pendingOperations():Promise<PendingOperation[]>;completeOperation(id:string,error?:string):Promise<void>;remapCategoryId(from:string,to:string):Promise<void>;remapSubcategoryId(from:string,to:string):Promise<void>;remapProductId(fromId:string,toId:string,updated:Product):Promise<void>;applyRemoteChange(x:{entityType:string;entityId:string;operation:string;payload:unknown}):Promise<void>;cacheRemoteImage(productId:string,representation:'grid'|'detail',url:string,version:number,expectedChecksum?:string,expectedSize?:number):Promise<void> }
class SqliteOpfsStorage implements CatalogueStorage {
 private db=new LocalSqlite();private ready=this.bootstrap()
 private imageMemoryCache=new Map<string,string>()
 private async bootstrap(){if(!this.db.isAvailable())return;try{await this.db.execute('CREATE TABLE IF NOT EXISTS local_entities(entity_type TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(entity_type,id))');if(await this.db.checkpoint('storage_schema_version')!=='5'){await this.db.execute("DELETE FROM local_entities WHERE (entity_type='product' AND id IN ('p1','p2')) OR (entity_type='category' AND id='rings') OR (entity_type='subcategory' AND id='solitaire') OR (entity_type='vendor' AND id='v1')");await this.db.setCheckpoint('storage_schema_version','5')}}catch{/* ignore in test runner */}}
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
  await this.db.execute('INSERT INTO local_entities(entity_type,id,payload,deleted,updated_at) VALUES(?,?,?,0,CURRENT_TIMESTAMP) ON CONFLICT(entity_type,id) DO UPDATE SET payload=excluded.payload,deleted=0,updated_at=CURRENT_TIMESTAMP',[type,id,JSON.stringify(value)])
 }
 private async values<T>(type:string){await this.ready;const x=await this.db.execute('SELECT payload FROM local_entities WHERE entity_type=? AND deleted=0 ORDER BY updated_at',[type]);return(x.rows||[]).map(r=>JSON.parse((r as {payload:string}).payload) as T)}
 private async persistProduct(x:Product,queue:boolean){
  let gridImage=x.gridImage,detailImage=x.detailImage;
  const grid=`${x.id}-grid-v${x.imageVersion}`,detail=`${x.id}-detail-v${x.imageVersion}`;
  if(x.gridImage.startsWith('data:')){
   this.imageMemoryCache.set(grid,x.gridImage);
   await this.db.putImage(grid,x.gridImage);
   gridImage=grid;
  }
  if(x.detailImage.startsWith('data:')){
   this.imageMemoryCache.set(detail,x.detailImage);
   await this.db.putImage(detail,x.detailImage);
   detailImage=detail;
  }
  await this.save('product',x.id,{...x,gridImage,detailImage});
  if(queue&&x.syncState!=='SYNCED'){
   await this.db.queueOperation('product','UPSERT',{id:x.id});
  }
 }
 async products(){
  const items=await this.values<Product>('product')
  const byCode=new Map<string,Product>()
  for(const item of items){
   const key=item.designCode.trim().toLowerCase()
   const curr=byCode.get(key)
   if(!curr){byCode.set(key,item)}
   else if(curr.syncState!=='SYNCED'&&item.syncState==='SYNCED'){byCode.set(key,item)}
  }
  const deduplicated=Array.from(byCode.values())
  const r2Base=(import.meta.env.VITE_R2_PUBLIC_BASE_URL||'https://pub-ddd4389cc31a46b6b365e21911f96e1f.r2.dev').replace(/\/$/,'')
  return Promise.all(deduplicated.map(async item=>{
   const load=async(path:string,representation:'grid'|'detail')=>{
    if(!path)return ''
    if(path.startsWith('data:')||path.startsWith('http://')||path.startsWith('https://'))return path
    if(this.imageMemoryCache.has(path))return this.imageMemoryCache.get(path)!
    try{
     const data=await this.db.getImage(path)
     if(data&&data.startsWith('data:')){
      this.imageMemoryCache.set(path,data)
      return data
     }
    }catch{/* not cached locally */}
    const key=representation==='grid'?item.gridImageKey:item.detailImageKey
    if(key)return `${r2Base}/${key.split('/').map(encodeURIComponent).join('/')}`
    return path
   }
   return {...item,gridImage:await load(item.gridImage,'grid'),detailImage:await load(item.detailImage,'detail')}
  }))
 }
 async hasLocalReplica(){await this.ready;const result=await this.db.execute("SELECT COUNT(*) count FROM local_entities WHERE entity_type='product' AND deleted=0");return Number((result.rows?.[0] as {count:number}|undefined)?.count||0)>0}
 async hasImage(path:string){if(this.imageMemoryCache.has(path))return true;await this.ready;return this.db.hasImage(path)}
 async deleteImage(path:string){this.imageMemoryCache.delete(path);await this.ready;return this.db.deleteImage(path)}
 async categories(){return(await this.values<Category>('category')).filter(x=>x.active)} async subcategories(){return(await this.values<Subcategory>('subcategory')).filter(x=>x.active)} async vendors(){return(await this.values<Vendor>('vendor')).filter(x=>!x.deleted)} async orders(){return this.values<Order>('order')} async session(){return(await this.values<Session>('offline-authorization'))[0]||null}
 async saveCategory(x:Category){await this.ready;await this.save('category',x.id,x);await this.db.queueOperation('category','UPSERT',x)} async saveSubcategory(x:Subcategory){await this.ready;await this.save('subcategory',x.id,x);await this.db.queueOperation('subcategory','UPSERT',x)} async saveVendor(x:Vendor){await this.ready;await this.save('vendor',x.id,x);await this.db.queueOperation('vendor','UPSERT',x)} async saveProduct(x:Product,queue=x.syncState!=='SYNCED'){await this.ready;await this.persistProduct(x,queue)} async saveOrder(x:Order){await this.ready;await this.save('order',x.id,x);await this.db.queueOperation('presentation','FINALIZE',x)}
 async saveSession(x:Session){await this.ready;await this.save('offline-authorization',x.userId,x);await this.db.setCheckpoint('offline_authorization_expires_at',x.offlineAuthorizationExpiresAt)} async clearSession(){await this.ready;await this.db.execute("UPDATE local_entities SET deleted=1,updated_at=CURRENT_TIMESTAMP WHERE entity_type='offline-authorization'")} async storageBytes(){await this.ready;const x=await this.db.execute('SELECT COALESCE(SUM(bytes),0) bytes FROM storage_accounting');return Number((x.rows?.[0] as {bytes:number}|undefined)?.bytes||0)}
 async syncCheckpoint(){await this.ready;return Number(await this.db.checkpoint('sync_checkpoint')||0)} async setSyncCheckpoint(x:number){await this.ready;await this.db.setCheckpoint('sync_checkpoint',String(x))} async pendingOperations(){await this.ready;return await this.db.pendingOperations() as PendingOperation[]} async completeOperation(id:string,error?:string){await this.ready;await this.db.operationState(id,error?'ERROR':'SYNCED',error)}
 async remapCategoryId(from:string,to:string){if(from===to)return;await this.ready;const category=(await this.values<Category>('category')).find(item=>item.id===from);if(category){await this.save('category',to,{...category,id:to});await this.db.execute('UPDATE local_entities SET deleted=1 WHERE entity_type=? AND id=?',['category',from])}for(const subcategory of await this.subcategories())if(subcategory.categoryId===from)await this.save('subcategory',subcategory.id,{...subcategory,categoryId:to});for(const product of await this.products())if(product.categoryId===from)await this.save('product',product.id,{...product,categoryId:to})}
 async remapSubcategoryId(from:string,to:string){if(from===to)return;await this.ready;const subcategory=(await this.subcategories()).find(item=>item.id===from);if(subcategory){await this.save('subcategory',to,{...subcategory,id:to});await this.db.execute('UPDATE local_entities SET deleted=1 WHERE entity_type=? AND id=?',['subcategory',from])}for(const product of await this.products())if(product.subcategoryId===from)await this.save('product',product.id,{...product,subcategoryId:to})}
 async remapProductId(fromId:string,toId:string,updated:Product){
  await this.ready;
  if(fromId!==toId){
   await this.db.execute("DELETE FROM local_entities WHERE entity_type='product' AND id=?",[fromId])
   await this.db.execute("DELETE FROM pending_operations WHERE entity_type='product' AND payload LIKE ?",[`%"id":"${fromId}"%`])
   const oldGrid=`${fromId}-grid-v${updated.imageVersion}`,newGrid=`${toId}-grid-v${updated.imageVersion}`
   const oldDetail=`${fromId}-detail-v${updated.imageVersion}`,newDetail=`${toId}-detail-v${updated.imageVersion}`
   if(this.imageMemoryCache.has(oldGrid))this.imageMemoryCache.set(newGrid,this.imageMemoryCache.get(oldGrid)!)
   if(this.imageMemoryCache.has(oldDetail))this.imageMemoryCache.set(newDetail,this.imageMemoryCache.get(oldDetail)!)
  }
  await this.persistProduct(updated,false)
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
  this.imageMemoryCache.set(path,data)
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
