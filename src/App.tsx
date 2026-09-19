import { useEffect, useMemo, useState } from 'react'
import { login, workerApi } from './api'
import { cloudImageStorageBytes, initialDownload, recoverMissingImages, synchronize, uploadPendingProductImages, uploadProductOnline } from './sync'
import { generateOrderPdf } from './pdf'
import { storage } from './storage'
import type { Category, Order, Product, Session, Subcategory, Vendor } from './types'
import { BatchEntry, ProductEntry, Taxonomy } from './Management'

const grams=(mg:number)=>(mg/1000).toFixed(3)
const uid=()=>crypto.randomUUID()
type View='catalogue'|'history'|'vendors'|'products'|'batch'|'taxonomy'|'storage'|'devices'
const sessionKey='shine-jewels.session'
const deviceKey='shine-jewels.device-id'

function deviceId(){
 const saved=localStorage.getItem(deviceKey)
 if(saved)return saved
 const value=crypto.randomUUID()
 localStorage.setItem(deviceKey,value)
 return value
}

function Login({onSession}:{onSession:(session:Session)=>void}){
 const [organizationId,setOrganizationId]=useState('shine-jewels-demo'),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[progressMsg,setProgressMsg]=useState('')
 const submit=async(event:React.FormEvent<HTMLFormElement>)=>{
  event.preventDefault();setError('');setBusy(true);setProgressMsg('Signing in…')
  try{
   const result=await login({organizationId,username,password,deviceId:deviceId(),deviceName:navigator.userAgent.includes('iPad')?'iPad browser':'Browser device'})
   const session:Session={userId:result.user.id,displayName:result.user.displayName||username,role:result.user.role,organizationId:result.user.organizationId,offlineAuthorizationExpiresAt:result.offlineAuthorizationExpiresAt}
   sessionStorage.setItem(sessionKey,JSON.stringify({...session,token:result.token}))
   await storage.saveSession(session)
   if(!await storage.hasLocalReplica()){
    setProgressMsg('Downloading catalogue…')
    await initialDownload(result.token,msg=>setProgressMsg(msg))
   }
   onSession(session)
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to sign in. Try again.')}
  finally{setBusy(false);setProgressMsg('')}
 }
 return <main className="login-shell"><section className="login-card" aria-labelledby="login-title"><div className="brand"><span className="mark">S</span><div><strong>shine jewels</strong><small>sales catalogue</small></div></div><p className="eyebrow">secure access</p><h1 id="login-title">Sign in to your catalogue.</h1><p>Use your organization account to continue.</p><form onSubmit={submit}><label>Organization ID<input value={organizationId} onChange={e=>setOrganizationId(e.target.value)} autoComplete="organization" required /></label><label>Username<input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" required autoFocus /></label><label>Password<input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete="current-password" required /></label>{error&&<p className="field-error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?(progressMsg||'Signing in…'):'Sign in'}</button></form></section></main>
}

export function App(){
 const [session,setSession]=useState<Session|null>(()=>{try{const value=sessionStorage.getItem(sessionKey);return value?JSON.parse(value) as Session:null}catch{return null}})
 const [products,setProducts]=useState<Product[]>([]),[categories,setCategories]=useState<Category[]>([]),[subcategories,setSubcategories]=useState<Subcategory[]>([]),[vendors,setVendors]=useState<Vendor[]>([]),[orders,setOrders]=useState<Order[]>([])
 const [view,setView]=useState<View>('catalogue'),[query,setQuery]=useState(''),[category,setCategory]=useState(''),[subcategory,setSubcategory]=useState(''),[selected,setSelected]=useState<Record<string,{quantity:number;remark:string}>>({}),[vendorId,setVendorId]=useState(''),[notice,setNotice]=useState(''),[detail,setDetail]=useState<Product|null>(null),[bytes,setBytes]=useState(0),[cloudBytes,setCloudBytes]=useState<number|null>(null),[uploading,setUploading]=useState(false),[syncing,setSyncing]=useState(false),[recovering,setRecovering]=useState(false),[syncCheckpointVal,setSyncCheckpointVal]=useState(0),[pendingCount,setPendingCount]=useState(0),[online,setOnline]=useState(navigator.onLine),[devices,setDevices]=useState<{id:string;device_id:string;device_name:string;last_seen_at:string;offline_authorization_expires_at:string;revoked_at:string|null}[]>([])
 const load=async()=>{const [p,c,s,v,o,b,cp,pending]=await Promise.all([storage.products(),storage.categories(),storage.subcategories(),storage.vendors(),storage.orders(),storage.storageBytes(),storage.syncCheckpoint(),storage.pendingOperations()]);setProducts(p);setCategories(c);setSubcategories(s);setVendors(v);setOrders(o);setBytes(b);setSyncCheckpointVal(cp);setPendingCount(pending.length)}
 const loadCloudStorage=async()=>{const saved=sessionStorage.getItem(sessionKey);if(!saved)return;try{setCloudBytes(await cloudImageStorageBytes((JSON.parse(saved) as {token:string}).token))}catch{setCloudBytes(null)}}
 const loadDevices=async()=>{const saved=sessionStorage.getItem(sessionKey);if(!saved)return;try{const list=await workerApi<{id:string;device_id:string;device_name:string;last_seen_at:string;offline_authorization_expires_at:string;revoked_at:string|null}[]>('/devices',{token:(JSON.parse(saved) as {token:string}).token});setDevices(list)}catch(err){setNotice(err instanceof Error?err.message:'Unable to load devices')}}
 const revokeDevice=async(deviceId:string)=>{const saved=sessionStorage.getItem(sessionKey);if(!saved)return;try{await workerApi(`/devices/${deviceId}/revoke`,{method:'POST',token:(JSON.parse(saved) as {token:string}).token});setNotice('Device session revoked. Device will be logged out upon reconnect.');await loadDevices()}catch(err){setNotice(err instanceof Error?err.message:'Unable to revoke device session')}}
 const triggerSync=async()=>{const saved=sessionStorage.getItem(sessionKey);if(!saved||syncing||!navigator.onLine)return;setSyncing(true);try{const token=(JSON.parse(saved) as {token:string}).token;const res=await synchronize(token,msg=>setNotice(msg));await load();await loadCloudStorage();setNotice(res.synced?`Sync complete: ${res.uploaded} uploaded, ${res.pulled} change(s) synced.`:'Device is offline.')}catch(err){setNotice(err instanceof Error?`Sync failed: ${err.message}`:'Sync failed.')}finally{setSyncing(false)}}
 const triggerImageRecovery=async()=>{const saved=sessionStorage.getItem(sessionKey);if(!saved||recovering||!navigator.onLine)return;setRecovering(true);try{const token=(JSON.parse(saved) as {token:string}).token;const res=await recoverMissingImages(token,msg=>setNotice(msg));await load();setNotice(`Recovery complete: ${res.recovered} restored, ${res.failed} unavailable.`)}catch(err){setNotice(err instanceof Error?`Recovery failed: ${err.message}`:'Recovery failed.')}finally{setRecovering(false)}}
 const uploadImages=async()=>{const saved=sessionStorage.getItem(sessionKey);if(!saved||uploading)return;setUploading(true);try{const result=await uploadPendingProductImages((JSON.parse(saved) as {token:string}).token);await load();await loadCloudStorage();setNotice(result.failed?`${result.uploaded} product image upload(s) completed; ${result.failed} remain queued.`:`${result.uploaded} product image upload(s) completed to R2.`)}catch(error){setNotice(error instanceof Error?`Image upload failed: ${error.message}`:'Image upload failed. Local images remain intact.')}finally{setUploading(false)}}
 useEffect(()=>{if(session){void load();void loadCloudStorage();if(session.role==='ADMIN')void loadDevices()}},[session])
 useEffect(()=>{const onOnline=()=>{setOnline(true);void triggerSync()};const onOffline=()=>{setOnline(false)};window.addEventListener('online',onOnline);window.addEventListener('offline',onOffline);return ()=>{window.removeEventListener('online',onOnline);window.removeEventListener('offline',onOffline)}},[session])
 const filtered=useMemo(()=>products.filter(p=>!p.deleted&&p.designCode.toLowerCase().includes(query.trim().toLowerCase())&&(!category||p.categoryId===category)&&(!subcategory||p.subcategoryId===subcategory)),[products,query,category,subcategory])
 const toggle=(id:string)=>setSelected(x=>x[id]?Object.fromEntries(Object.entries(x).filter(([k])=>k!==id)):{...x,[id]:{quantity:1,remark:''}})
 const change=(id:string,key:'quantity'|'remark',value:string)=>setSelected(s=>({...s,[id]:{...s[id], [key]:key==='quantity'?Math.max(1,Number(value)||1):value}}))
 const makeOrder=async()=>{const vendor=vendors.find(v=>v.id===vendorId);const picks=products.filter(p=>selected[p.id]); if(!vendor){setNotice('Select a vendor before reviewing the order.');return} if(!picks.length){setNotice('Select at least one design.');return};const max=Math.max(0,...orders.map(o=>o.orderNumber||0));const order:Order={id:uid(),orderNumber:max+1,vendor,salesperson:session?.displayName||'Salesperson',status:'FINALIZED',createdAt:new Date().toISOString(),generatedAt:new Date().toISOString(),items:picks.map((p,index)=>({productId:p.id,serialNumber:index+1,designCode:p.designCode,category:categories.find(c=>c.id===p.categoryId)?.name||'',subcategory:subcategories.find(s=>s.id===p.subcategoryId)?.name||'',weightMg:p.weightMg,quantity:selected[p.id].quantity,remark:selected[p.id].remark,image:p.gridImage}))};await storage.saveOrder(order);setOrders(o=>[order,...o]);await generateOrderPdf(order);setSelected({});await load();setNotice(`Order #${order.orderNumber} finalized locally. PDF download started.`)}
 const addVendor=async(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();const fd=new FormData(e.currentTarget),name=String(fd.get('name')||'').trim(),city=String(fd.get('city')||'').trim(),address=String(fd.get('address')||'').trim(),type=String(fd.get('type')||'WHOLESALE') as Vendor['type'];if(!name||!city||!address){setNotice('Vendor name, business address and city are required.');return};if(vendors.some(v=>v.name.trim().toLowerCase()===name.toLowerCase()&&v.city.trim().toLowerCase()===city.toLowerCase())){setNotice('A vendor with this name and city already exists.');return};const v={id:uid(),name,address,city,type};await storage.saveVendor(v);await load();e.currentTarget.reset();setNotice('Vendor saved locally.')}
 const stageProduct=async(product:Product)=>{
  if(products.some(p=>p.designCode.toLowerCase()===product.designCode.toLowerCase())){
   setNotice(`Design code ${product.designCode} already exists. The draft image remains available for retry.`);
   return
  };
  const saved=sessionStorage.getItem(sessionKey);
  const token=saved?(JSON.parse(saved) as {token:string}).token:'';
  const isOnline=navigator.onLine&&Boolean(token);

  if(!isOnline){
   try{
    await storage.saveProduct({...product,syncState:'PENDING_UPLOAD'},true);
    await load();
    setNotice(`${product.designCode} staged locally (offline). It will sync automatically when online.`);
   }catch(error){
    setNotice(error instanceof Error?`Image could not be saved on this device: ${error.message}`:'Image could not be saved on this device.')
   }
   return
  }

  try{
   await storage.saveProduct({...product,syncState:'PENDING_UPLOAD'},false);
   await load();
   setNotice(`Uploading ${product.designCode} directly to cloud storage (R2)…`);
   try{
    await uploadProductOnline(token,product.id);
    await load();
    await loadCloudStorage();
    setNotice(`${product.designCode} uploaded directly to R2 and synchronized.`);
   }catch(uploadErr){
    console.warn('Online direct upload failed, falling back to offline queue:',uploadErr);
    await storage.saveProduct({...product,syncState:'PENDING_UPLOAD'},true);
    await load();
    setNotice(`${product.designCode} saved locally. Cloud upload failed (${uploadErr instanceof Error?uploadErr.message:'network issue'}); queued for sync.`);
   }
  }catch(error){
   setNotice(error instanceof Error?`Could not save product: ${error.message}`:'Could not save product.')
  }
 }
 const addCategory=async(c:Category)=>{await storage.saveCategory(c);await load()}
 const addSubcategory=async(s:Subcategory)=>{await storage.saveSubcategory(s);await load()}
 const cart=products.filter(p=>selected[p.id]); const total=cart.reduce((n,p)=>n+p.weightMg*selected[p.id].quantity,0)
 if(!session)return <Login onSession={setSession}/>
 const commonViews:View[]=['catalogue','history','vendors','products','batch','taxonomy','storage']
 const views=(session.role==='ADMIN'?[...commonViews,'devices']:commonViews) as View[]
 const logout=()=>{sessionStorage.removeItem(sessionKey);void storage.clearSession();setSession(null)}
 return <div className="app-shell"><header><div className="brand"><span className="mark">S</span><div><strong>shine jewels</strong><small>{session.role==='ADMIN'?'administrator':'sales catalogue'}</small></div></div><div className="session-actions"><div className="connection" style={{color:online?(syncing?'var(--gold)':'var(--green)'):'var(--muted)'}}><i style={{background:online?(syncing?'var(--gold)':'var(--green)'):'var(--muted)'}}/> {online?(syncing?'Syncing…':`Online · ${session.displayName}`):`Offline · ${session.displayName}`}</div><button className="quiet logout" onClick={logout}>Log out</button></div></header>
 <nav aria-label="Primary navigation">{views.map(item=><button key={item} className={view===item?'active':''} onClick={()=>setView(item)}>{item}</button>)}</nav>
 {notice&&<div className="notice" role="status">{notice}<button onClick={()=>setNotice('')} aria-label="Dismiss message">×</button></div>}
 <main className="catalogue-layout" style={{display:view==='catalogue'?undefined:'none'}}><section className="catalogue"><div className="section-title"><div><p className="eyebrow">design library</p><h1>Find the right piece, without waiting.</h1></div><span>{filtered.length} designs</span></div><div className="filters"><label>Search design code<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="e.g. SJ-1001" /></label><label>Category<select value={category} onChange={e=>{setCategory(e.target.value);setSubcategory('')}}><option value="">All categories</option>{categories.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label>Subcategory<select value={subcategory} onChange={e=>setSubcategory(e.target.value)}><option value="">All subcategories</option>{subcategories.filter(s=>!category||s.categoryId===category).map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label><button className="quiet" onClick={()=>{setQuery('');setCategory('');setSubcategory('')}}>Clear filters</button></div>
 <div className="grid">{filtered.map(product=><article className={'product '+(selected[product.id]?'chosen':'')} key={product.id}><button className="image-button" onClick={()=>setDetail(product)} aria-label={`View ${product.designCode}`}><img src={product.gridImage} alt={`${product.designCode} jewelry design`} loading="eager" decoding="async" /></button><div className="product-meta"><div><strong>{product.designCode}</strong><span>{grams(product.weightMg)} g</span></div><button className="select" aria-pressed={Boolean(selected[product.id])} onClick={()=>toggle(product.id)}>{selected[product.id]?'Selected':'Select'}</button></div></article>)}</div></section><aside className="order-tray"><p className="eyebrow">manufacturer order</p><h2>{cart.length?`${cart.length} designs selected`:'Start with a vendor'}</h2><label>Vendor<select value={vendorId} onChange={e=>setVendorId(e.target.value)}><option value="">Choose vendor</option>{vendors.map(v=><option value={v.id} key={v.id}>{v.name} · {v.city}</option>)}</select></label><div className="line"/>{cart.length===0?<p className="muted">Select designs from the catalogue. Your work stays on this device when offline.</p>:<div className="cart">{cart.map(p=><div className="cart-item" key={p.id}><img src={p.gridImage} alt="" /><div><strong>{p.designCode}</strong><span>{grams(p.weightMg)} g</span><label>Qty<input aria-label={`Quantity for ${p.designCode}`} type="number" min="1" step="1" value={selected[p.id].quantity} onChange={e=>change(p.id,'quantity',e.target.value)} /></label><input aria-label={`Remark for ${p.designCode}`} value={selected[p.id].remark} onChange={e=>change(p.id,'remark',e.target.value)} placeholder="Optional remark" /></div></div>)}</div>}<div className="total"><span>Total weight</span><strong>{grams(total)} g</strong></div><button className="primary" onClick={()=>void makeOrder()}>Finalize &amp; generate PDF</button><small>PDF is generated locally. Cloud sync follows when connected.</small></aside></main>
 {view==='vendors'&&<main className="single-view"><div className="section-title"><div><p className="eyebrow">vendor directory</p><h1>Vendors for every order.</h1></div></div><div className="management"><form onSubmit={addVendor}><h2>Add vendor</h2><label>Name<input name="name" required /></label><label>Business address<input name="address" required /></label><label>City<input name="city" required /></label><label>Type<select name="type"><option>WHOLESALE</option><option>RETAIL</option><option>CORPORATE</option></select></label><button className="primary">Save vendor</button></form><div className="records">{vendors.map(v=><article key={v.id}><strong>{v.name}</strong><span>{v.address}, {v.city}</span><small>{v.type}</small></article>)}</div></div></main>}
 {view==='products'&&<main className="single-view"><p className="eyebrow">catalogue administration</p><h1>Stage a single design with confidence.</h1><ProductEntry categories={categories} subcategories={subcategories} onProduct={stageProduct}/></main>}
 {view==='batch'&&<main className="single-view"><BatchEntry categories={categories} subcategories={subcategories} onProduct={stageProduct}/></main>}
 {view==='taxonomy'&&<main className="single-view"><Taxonomy categories={categories} subcategories={subcategories} onCategory={addCategory} onSubcategory={addSubcategory} notice={setNotice}/></main>}
 {view==='history'&&<main className="single-view"><p className="eyebrow">synchronized history</p><h1>Orders retain their original details.</h1><div className="history">{orders.length?orders.map(o=><article key={o.id}><div><strong>#{String(o.orderNumber).padStart(4,'0')} · {o.vendor.name}</strong><span>{new Date(o.generatedAt||o.createdAt).toLocaleString()} · {o.salesperson}</span></div><b>{o.items.reduce((n,i)=>n+i.quantity,0)} pcs · {grams(o.items.reduce((n,i)=>n+i.weightMg*i.quantity,0))} g</b><details><summary>View design snapshots</summary>{o.items.map(i=><p key={i.productId}>{i.designCode} · {i.category}/{i.subcategory} · {i.quantity} × {grams(i.weightMg)} g</p>)}</details></article>):<p className="muted">No finalized orders on this device yet.</p>}</div></main>}
 {view==='storage'&&<main className="single-view storage"><div className="section-title"><div><p className="eyebrow">device replica</p><h1>Storage &amp; synchronization</h1></div><span>Checkpoint #{syncCheckpointVal}</span></div><div className="storage-card"><strong>{cloudBytes===null?'—':(cloudBytes/1024).toFixed(1)+' KB'}</strong><span>Cloud R2 catalogue images</span><p>Calculated from the authenticated organization’s confirmed grid/detail image metadata. This is the cloud catalogue total, not a browser cache estimate.</p><strong>{(bytes/1024).toFixed(1)} KB</strong><span>This device’s OPFS image replica</span><p>Images saved while working offline are counted here separately and remain on this device until explicitly cleared.</p><div style={{display:'flex',gap:'10px',alignItems:'center',padding:'8px 0'}}><span>Offline queue:</span><strong>{pendingCount} operation(s) pending sync</strong>{pendingCount>0&&<button className="quiet" style={{minHeight:'28px',padding:'0 8px',fontSize:'12px'}} onClick={async()=>{await storage.clearPendingOperations();await load();setNotice('Pending operations queue cleared.')}}>Clear queue</button>}</div><button className="primary" disabled={syncing||!online} onClick={()=>void triggerSync()}>{syncing?'Synchronizing…':'Run Full Synchronization'}</button><button className="quiet" disabled={recovering||!online} onClick={()=>void triggerImageRecovery()}>{recovering?'Recovering images…':'Scan & Recover Missing Images'}</button><button className="quiet" disabled={uploading||!online} onClick={()=>void uploadImages()}>{uploading?'Uploading pending images…':'Upload pending product images'}</button><button className="quiet" onClick={()=>{void load();void loadCloudStorage()}}>Refresh storage estimate</button></div></main>}
 {view==='devices'&&session.role==='ADMIN'&&<main className="single-view"><div className="section-title"><div><p className="eyebrow">security &amp; administration</p><h1>Authorized Device Sessions</h1></div><span>{devices.length} registered</span></div><div className="records">{devices.map(d=><article key={d.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><div><strong>{d.device_name}</strong><span>Device ID: {d.device_id}</span><small>Last seen: {new Date(d.last_seen_at).toLocaleString()} · Expires: {new Date(d.offline_authorization_expires_at).toLocaleDateString()}</small>{d.revoked_at&&<span style={{color:'var(--danger)'}}>Revoked on {new Date(d.revoked_at).toLocaleString()}</span>}</div>{!d.revoked_at&&<button className="quiet" style={{color:'var(--danger)',borderColor:'var(--danger)'}} onClick={()=>void revokeDevice(d.id)}>Revoke access</button>}</article>)}</div></main>}
 {detail&&<div className="modal" role="dialog" aria-modal="true" aria-label={`${detail.designCode} details`}><button className="close" onClick={()=>setDetail(null)} aria-label="Close detail">×</button><img src={detail.detailImage} alt={`${detail.designCode} detailed jewelry view`} /><div><p className="eyebrow">local detail image</p><h2>{detail.designCode}</h2><p>{grams(detail.weightMg)} g · {categories.find(c=>c.id===detail.categoryId)?.name}</p><button className="primary" onClick={()=>{toggle(detail.id);setDetail(null)}}>{selected[detail.id]?'Remove selection':'Select design'}</button></div></div>}
 <footer>Built by Aadit Mehta, contact mail: <a href="mailto:aaditbusiness15@gmail.com">aaditbusiness15@gmail.com</a></footer></div>
}
