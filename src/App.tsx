import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: '' }
  }
  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, error: error instanceof Error ? error.message : String(error) }
  }
  componentDidCatch(error: unknown, info: unknown) {
    console.error('ErrorBoundary caught an error:', error, info)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px 20px', maxWidth: '600px', margin: '60px auto', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '14px', textAlign: 'center' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--danger)', margin: '0 0 10px' }}>Notice</h2>
          <p style={{ color: 'var(--muted)', fontSize: '14px', lineHeight: '1.5', margin: '0 0 20px' }}>{this.state.error || 'A display issue occurred.'}</p>
          <button className="primary" style={{ maxWidth: '220px', margin: '0 auto' }} onClick={() => { this.setState({ hasError: false, error: '' }); window.location.reload() }}>
            Reload Application
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
import { login, workerApi } from './api'
import { cloudImageStorageBytes, initialDownload, push, recoverMissingImages, synchronize, uploadPendingProductImages } from './sync'
import { createOrderPdfBlob, downloadPdfBlob, sharePdfFile, type GeneratedPdfResult } from './pdf'
import { storage } from './storage'
import type { Category, Order, Product, Session, Subcategory, Vendor } from './types'
import { BatchEntry, ProductEntry, Taxonomy } from './Management'
import { EditProductModal, ArchiveConfirmModal } from './ProductModals'
import { EditVendorModal, ArchiveVendorModal } from './VendorModals'

const grams=(mg:number)=>(mg/1000).toFixed(3)
const uid=()=>crypto.randomUUID()
const INITIAL_BATCH_SIZE = 40
const BATCH_INCREMENT = 24
type View='catalogue'|'history'|'vendors'|'products'|'batch'|'taxonomy'|'storage'|'devices'
const sessionKey='shine-jewels.session'
const deviceKey='shine-jewels.device-id'

export function getStoredToken(): string {
 try {
  const raw = localStorage.getItem(sessionKey) || sessionStorage.getItem(sessionKey)
  if (!raw) return ''
  return (JSON.parse(raw) as { token?: string }).token || ''
 } catch {
  return ''
 }
}

export function getStoredSession(): (Session & { token?: string }) | null {
 try {
  const raw = localStorage.getItem(sessionKey) || sessionStorage.getItem(sessionKey)
  if (!raw) return null
  const parsed = JSON.parse(raw) as Session & { token?: string }
  if (parsed && parsed.userId && parsed.organizationId) return parsed
  return null
 } catch {
  return null
 }
}

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
   const sessionPayload = { ...session, token: result.token }
   localStorage.setItem(sessionKey, JSON.stringify(sessionPayload))
   sessionStorage.setItem(sessionKey, JSON.stringify(sessionPayload))
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
 const [session,setSession]=useState<Session|null>(()=>getStoredSession())
 const [products,setProducts]=useState<Product[]>([]),[categories,setCategories]=useState<Category[]>([]),[subcategories,setSubcategories]=useState<Subcategory[]>([]),[vendors,setVendors]=useState<Vendor[]>([]),[orders,setOrders]=useState<Order[]>([])
 const [view,setView]=useState<View>('catalogue'),[query,setQuery]=useState(''),[category,setCategory]=useState(''),[subcategory,setSubcategory]=useState(''),[minWeight,setMinWeight]=useState(''),[maxWeight,setMaxWeight]=useState(''),[sliderActive,setSliderActive]=useState<'min'|'max'>('max'),[selected,setSelected]=useState<Record<string,{quantity:number;remark:string}>>({}),[vendorId,setVendorId]=useState(''),[notice,setNotice]=useState(''),[detail,setDetail]=useState<Product|null>(null),[pdfPreview,setPdfPreview]=useState<GeneratedPdfResult|null>(null),[generatingPdf,setGeneratingPdf]=useState(false),[bytes,setBytes]=useState(0),[cloudBytes,setCloudBytes]=useState<number|null>(null),[uploading,setUploading]=useState(false),[syncing,setSyncing]=useState(false),[recovering,setRecovering]=useState(false),[syncCheckpointVal,setSyncCheckpointVal]=useState(0),[pendingCount,setPendingCount]=useState(0),[online,setOnline]=useState(navigator.onLine),[devices,setDevices]=useState<{id:string;device_id:string;device_name:string;last_seen_at:string;offline_authorization_expires_at:string;revoked_at:string|null}[]>([])
 const [editingProduct,setEditingProduct]=useState<Product|null>(null),[archivingProduct,setArchivingProduct]=useState<Product|null>(null),[archivedProductsList,setArchivedProductsList]=useState<Product[]>([]),[adminProductTab,setAdminProductTab]=useState<'active'|'add'|'archived'>('active'),[adminSearch,setAdminSearch]=useState('')
 const [archivedVendorsList,setArchivedVendorsList]=useState<Vendor[]>([]),[archivedCategoriesList,setArchivedCategoriesList]=useState<Category[]>([]),[archivedSubcategoriesList,setArchivedSubcategoriesList]=useState<Subcategory[]>([])
 const [editingVendor,setEditingVendor]=useState<Vendor|null>(null),[archivingVendor,setArchivingVendor]=useState<Vendor|null>(null),[adminVendorTab,setAdminVendorTab]=useState<'active'|'add'|'archived'>('active'),[vendorSearch,setVendorSearch]=useState('')
 const [visibleCount,setVisibleCount]=useState<number>(INITIAL_BATCH_SIZE)
 const sentinelRef=useRef<HTMLDivElement|null>(null)
 const [resolvedDetailUrl,setResolvedDetailUrl]=useState<string>('')
 const maxPossibleWeight = useMemo(()=>{const active=products.filter(p=>!p.deleted).map(p=>p.weightMg/1000);return active.length?Math.max(50,Math.ceil(Math.max(...active))):100},[products])
 const currentMinVal = minWeight !== '' ? Math.max(0, Math.round(Number(minWeight))) : 0
 const currentMaxVal = maxWeight !== '' ? Math.min(maxPossibleWeight, Math.round(Number(maxWeight))) : maxPossibleWeight
 const leftPercent = Math.min(100, Math.max(0, (currentMinVal / maxPossibleWeight) * 100))
 const rightPercent = Math.min(100, Math.max(0, (currentMaxVal / maxPossibleWeight) * 100))
 const widthPercent = Math.max(0, rightPercent - leftPercent)
 const onSliderMinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const v = Math.min(Number(e.target.value), currentMaxVal)
  setMinWeight(v <= 0 ? '' : String(v))
 }
 const onSliderMaxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const v = Math.max(Number(e.target.value), currentMinVal)
  setMaxWeight(v >= maxPossibleWeight ? '' : String(v))
 }
 const filtered=useMemo(()=>{const minMg=minWeight!==''?Math.round(Number(minWeight)*1000):0,maxMg=maxWeight!==''?Math.round(Number(maxWeight)*1000):Infinity;return products.filter(p=>!p.deleted&&p.designCode.toLowerCase().includes(query.trim().toLowerCase())&&(!category||p.categoryId===category)&&(!subcategory||p.subcategoryId===subcategory)&&p.weightMg>=minMg&&p.weightMg<=maxMg)},[products,query,category,subcategory,minWeight,maxWeight])
 useEffect(()=>{
  setVisibleCount(INITIAL_BATCH_SIZE)
 },[query,category,subcategory,minWeight,maxWeight])
 const visibleProducts=useMemo(()=>filtered.slice(0,visibleCount),[filtered,visibleCount])
 useEffect(()=>{
  const sentinel=sentinelRef.current
  if(!sentinel)return
  const observer=new IntersectionObserver((entries)=>{
   const first=entries[0]
   if(first&&first.isIntersecting){
    setVisibleCount(prev=>(prev<filtered.length?Math.min(filtered.length,prev+BATCH_INCREMENT):prev))
   }
  },{rootMargin:'600px 0px'})
  observer.observe(sentinel)
  return()=>observer.disconnect()
 },[filtered.length])
 useEffect(()=>{
  if(detail){
   const idx=filtered.findIndex(p=>p.id===detail.id)
   if(idx>=visibleCount){
    setVisibleCount(Math.min(filtered.length,idx+BATCH_INCREMENT))
   }
  }
 },[detail,filtered,visibleCount])
 useEffect(()=>{
  if(!detail){
   setResolvedDetailUrl('')
   return
  }
  let active=true
  const isCorruptDetail = detail.detailImageSizeBytes !== undefined && detail.detailImageSizeBytes > 0 && detail.detailImageSizeBytes < 1000
  const fallback = (!isCorruptDetail && (detail.detailImage?.startsWith('data:') || detail.detailImage?.startsWith('http')))
    ? detail.detailImage
    : detail.gridImage
  setResolvedDetailUrl(fallback)
  storage.resolveDetailImage(detail).then(url=>{
   if(active&&url){
    setResolvedDetailUrl(url)
   }
  }).catch(()=>{
   if(active)setResolvedDetailUrl(detail.gridImage)
  })
  return()=>{active=false}
 },[detail?.id,detail?.detailImage,detail?.gridImage,detail?.detailImageSizeBytes])
 const clearFilters=()=>{setQuery('');setCategory('');setSubcategory('');setMinWeight('');setMaxWeight('')}
 const applyWeightPreset=(min:string,max:string)=>{setMinWeight(min);setMaxWeight(max)}
 const detailIndex = detail ? filtered.findIndex(p => p.id === detail.id) : -1
 const activeList = detailIndex !== -1 ? filtered : products
 const activeIndex = detail ? activeList.findIndex(p => p.id === detail.id) : -1
 const hasPrev = activeIndex > 0
 const hasNext = activeIndex >= 0 && activeIndex < activeList.length - 1
 const goPrev = () => { if (hasPrev) setDetail(activeList[activeIndex - 1]) }
 const goNext = () => { if (hasNext) setDetail(activeList[activeIndex + 1]) }
 const touchStartX = useRef<number | null>(null)
 const touchStartY = useRef<number | null>(null)
 const handleTouchStart = (e: React.TouchEvent) => {
  touchStartX.current = e.touches[0].clientX
  touchStartY.current = e.touches[0].clientY
 }
 const handleTouchEnd = (e: React.TouchEvent) => {
  if (touchStartX.current === null || touchStartY.current === null) return
  const deltaX = e.changedTouches[0].clientX - touchStartX.current
  const deltaY = e.changedTouches[0].clientY - touchStartY.current
  touchStartX.current = null
  touchStartY.current = null
  if (Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(deltaY)) {
   if (deltaX < 0) goNext()
   else goPrev()
  }
 }
 useEffect(() => {
  if (!detail) return
  const handleKeyDown = (e: KeyboardEvent) => {
   if (e.key === 'ArrowRight') {
    e.preventDefault()
    goNext()
   } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    goPrev()
   } else if (e.key === 'Escape') {
    e.preventDefault()
    setDetail(null)
   }
  }
  window.addEventListener('keydown', handleKeyDown)
  return () => window.removeEventListener('keydown', handleKeyDown)
 }, [detail, activeIndex, activeList, hasPrev, hasNext])
  const load=async()=>{const [p,c,s,v,o,b,cp,pending,archivedP,archivedV,archivedC,archivedS]=await Promise.all([storage.products(),storage.categories(),storage.subcategories(),storage.vendors(),storage.orders(),storage.storageBytes(),storage.syncCheckpoint(),storage.pendingOperations(),storage.archivedProducts(),storage.archivedVendors(),storage.archivedCategories(),storage.archivedSubcategories()]);setProducts(p);setCategories(c);setSubcategories(s);setVendors(v);setOrders(o);setBytes(b);setSyncCheckpointVal(cp);setPendingCount(pending.length);setArchivedProductsList(archivedP);setArchivedVendorsList(archivedV);setArchivedCategoriesList(archivedC);setArchivedSubcategoriesList(archivedS);return p}
  const loadCloudStorage=async()=>{const token=getStoredToken();if(!token)return;try{setCloudBytes(await cloudImageStorageBytes(token))}catch{setCloudBytes(null)}}
  const loadDevices=async()=>{const token=getStoredToken();if(!token)return;try{const list=await workerApi<{id:string;device_id:string;device_name:string;last_seen_at:string;offline_authorization_expires_at:string;revoked_at:string|null}[]>('/devices',{token});setDevices(list)}catch(err){setNotice(err instanceof Error?err.message:'Unable to load devices')}}
  const revokeDevice=async(deviceId:string)=>{const token=getStoredToken();if(!token)return;try{await workerApi(`/devices/${deviceId}/revoke`,{method:'POST',token});setNotice('Device session revoked. Device will be logged out upon reconnect.');await loadDevices()}catch(err){setNotice(err instanceof Error?err.message:'Unable to revoke device session')}}
  const triggerSync=async()=>{const token=getStoredToken();if(!token||syncing||!navigator.onLine)return;setSyncing(true);try{const res=await synchronize(token,msg=>setNotice(msg));await load();await loadCloudStorage();setNotice(res.synced?`Sync complete: ${res.uploaded} uploaded, ${res.pulled} change(s) synced.`:'Device is offline.')}catch(err){setNotice(err instanceof Error?`Sync failed: ${err.message}`:'Sync failed.')}finally{setSyncing(false)}}
  const triggerImageRecovery=async()=>{const token=getStoredToken();if(!token||recovering||!navigator.onLine)return;setRecovering(true);try{const res=await recoverMissingImages(token,msg=>setNotice(msg));await load();setNotice(`Recovery complete: ${res.recovered} restored, ${res.failed} unavailable.`)}catch(err){setNotice(err instanceof Error?`Recovery failed: ${err.message}`:'Recovery failed.')}finally{setRecovering(false)}}
  const uploadImages=async()=>{const token=getStoredToken();if(!token||uploading)return;setUploading(true);try{const result=await uploadPendingProductImages(token);await load();await loadCloudStorage();setNotice(result.failed?`${result.uploaded} product image upload(s) completed; ${result.failed} remain queued.`:`${result.uploaded} product image upload(s) completed to R2.`)}catch(error){setNotice(error instanceof Error?`Image upload failed: ${error.message}`:'Image upload failed. Local images remain intact.')}finally{setUploading(false)}}
  useEffect(()=>{
    if(!session)return;
    let active=true;
    const init=async()=>{
      const p=await load();
      void loadCloudStorage();
      if(session.role==='ADMIN')void loadDevices();
      const token=getStoredToken();
      if(token&&navigator.onLine){
        if(p.length===0){
          setNotice('Synchronizing catalogue from cloud…');
          try{
            await initialDownload(token,msg=>{if(active)setNotice(msg)});
            if(active){
              await load();
              await loadCloudStorage();
              setNotice('Catalogue synchronized.');
            }
          }catch(err){
            console.warn('Initial download error:',err);
            if(active)setNotice(err instanceof Error?`Sync error: ${err.message}`:'Sync error.');
          }
        }else{
          void triggerSync();
        }
      }
    };
    void init();
    return ()=>{active=false};
  },[session])
  useEffect(()=>{const onOnline=()=>{setOnline(true);void triggerSync()};const onOffline=()=>{setOnline(false)};window.addEventListener('online',onOnline);window.addEventListener('offline',onOffline);return ()=>{window.removeEventListener('online',onOnline);window.removeEventListener('offline',onOffline)}},[session])
  useEffect(()=>{if(view==='history'&&online){void triggerSync()}},[view,online])
 const toggle=(id:string)=>setSelected(x=>x[id]?Object.fromEntries(Object.entries(x).filter(([k])=>k!==id)):{...x,[id]:{quantity:1,remark:''}})
 const change=(id:string,key:'quantity'|'remark',value:string)=>setSelected(s=>({...s,[id]:{...s[id], [key]:key==='quantity'?Math.max(1,Number(value)||1):value}}))
 const makeOrder=async()=>{const vendor=vendors.find(v=>v.id===vendorId);const picks=products.filter(p=>selected[p.id]);if(!vendor){setNotice('Select a vendor before reviewing the order.');return}if(!picks.length){setNotice('Select at least one design.');return};const max=Math.max(0,...orders.map(o=>o.orderNumber||0));const order:Order={id:uid(),orderNumber:max+1,vendor,salesperson:session?.displayName||'Salesperson',status:'FINALIZED',createdAt:new Date().toISOString(),generatedAt:new Date().toISOString(),items:picks.map((p,index)=>({productId:p.id,serialNumber:index+1,designCode:p.designCode,category:categories.find(c=>c.id===p.categoryId)?.name||'',subcategory:subcategories.find(s=>s.id===p.subcategoryId)?.name||'',weightMg:p.weightMg,quantity:selected[p.id].quantity,remark:selected[p.id].remark,image:p.gridImage}))};await storage.saveOrder(order);setOrders(o=>[order,...o]);setSelected({});await load();setNotice(`Order #${order.orderNumber} finalized. Generating PDF preview…`);setGeneratingPdf(true);try{const res=await createOrderPdfBlob(order);setPdfPreview(res);setNotice(`Order #${order.orderNumber} PDF preview is ready.`)}catch(err){setNotice(err instanceof Error?`PDF generation failed: ${err.message}`:'PDF generation failed.')}finally{setGeneratingPdf(false)}}
  const openOrderPdfPreview=async(order:Order)=>{setGeneratingPdf(true);setNotice(`Generating PDF for Order #${order.orderNumber}…`);try{const res=await createOrderPdfBlob(order);setPdfPreview(res);setNotice(`Order #${order.orderNumber} PDF preview is ready.`)}catch(err){setNotice(err instanceof Error?`PDF generation failed: ${err.message}`:'PDF generation failed.')}finally{setGeneratingPdf(false)}}
 const addVendor=async(e:React.FormEvent<HTMLFormElement>)=>{
  e.preventDefault();
  const form=e.currentTarget;
  const fd=new FormData(form),name=String(fd.get('name')||'').trim(),city=String(fd.get('city')||'').trim(),address=String(fd.get('address')||'').trim(),type=String(fd.get('type')||'WHOLESALE') as Vendor['type'];
  if(!name||!city||!address){setNotice('Vendor name, business address and city are required.');return};
  if(vendors.some(v=>v.name.trim().toLowerCase()===name.toLowerCase()&&v.address.trim().toLowerCase()===address.toLowerCase())){setNotice('A vendor with this name and address already exists.');return};
  form.reset();
  const v:Vendor={id:uid(),name,address,city,type};
  await storage.saveVendor(v);
  await load();

  const token=getStoredToken();
  const isOnline=navigator.onLine&&Boolean(token);
  if(isOnline){
    try{
      const res=await workerApi<Vendor>('/vendors',{method:'POST',token,body:v});
      if(res&&res.id&&res.id!==v.id){
        await storage.remapVendorId(v.id,res.id,res);
      }
      const pending=(await storage.pendingOperations()).find(op=>op.entity_type==='vendor'&&((JSON.parse(op.payload||'{}') as {id?:string}).id===v.id));
      if(pending){
        await storage.completeOperation(pending.id);
      }
      await load();
      setNotice(`Vendor "${v.name}" saved locally and synced to cloud.`);
      return;
    }catch(err){
      console.warn('Direct vendor cloud push error, fallback to background sync:',err);
      triggerBackgroundUpload();
      setNotice(`Vendor "${v.name}" saved locally. Cloud sync pending.`);
      return;
    }
  }
  setNotice(`Vendor "${v.name}" saved locally (offline). It will sync automatically when online.`);
 }
 const uploadingRef = useRef(false)
 const triggerBackgroundUpload = () => {
  const token = getStoredToken();
  if (!token || !navigator.onLine) return;
  if (uploadingRef.current || syncing) return;
  uploadingRef.current = true;
  setUploading(true);

  (async () => {
   let uploaded = 0;
   let lastError = '';
   let lastOp = '';
   try {
    while (navigator.onLine) {
     const pending = (await storage.pendingOperations()).filter(op => ['product', 'vendor', 'category', 'subcategory'].includes(op.entity_type));
     if (pending.length === 0) break;
     const op = pending[0];
     lastOp = op.operation;
     try {
      const res = await push(token, op);
      await storage.completeOperation(op.id);
      if (res) {
       uploaded++;
       await load();
       await loadCloudStorage();
       const entityLabel = op.entity_type === 'product' ? 'Design' : op.entity_type.charAt(0).toUpperCase() + op.entity_type.slice(1);
       if (op.operation === 'RESTORE') {
        setNotice(`${entityLabel} restored and synchronized with cloud.`);
       } else if (op.operation === 'ARCHIVE') {
        setNotice(`${entityLabel} archived and synchronized with cloud.`);
       } else {
        setNotice(`${entityLabel} saved and synchronized with cloud.`);
       }
      }
     } catch (err) {
      lastError = err instanceof Error ? err.message : 'Upload failed';
      console.warn('Background upload failed for item:', op.id, err);
      await storage.completeOperation(op.id, lastError);
      break;
     }
    }
   } finally {
    uploadingRef.current = false;
    setUploading(false);
    await load();
    await loadCloudStorage();
    if (lastError) {
     setNotice(`Sync stopped: ${lastError}. Changes remain in local queue for retry.`);
    } else if (uploaded > 0) {
     if (lastOp === 'RESTORE') {
      setNotice('Item successfully restored to active cloud catalogue.');
     } else if (lastOp === 'ARCHIVE') {
      setNotice('Item successfully archived in cloud catalogue.');
     } else {
      setNotice(`Cloud synchronization completed: ${uploaded} change(s) successfully synchronized.`);
     }
    }
   }
  })();
 };
 const stageProduct=async(product:Product)=>{
  if(products.some(p=>p.designCode.toLowerCase()===product.designCode.toLowerCase())){
   setNotice(`Design code ${product.designCode} already exists. The draft image remains available for retry.`);
   return
  };

  try{
   await storage.saveProduct({...product,syncState:'PENDING_UPLOAD'},true);
   await load();
   await loadCloudStorage();

   const saved=sessionStorage.getItem(sessionKey);
   const token=saved?(JSON.parse(saved) as {token:string}).token:'';
   const isOnline=navigator.onLine&&Boolean(token);

   if(!isOnline){
    setNotice(`${product.designCode} saved locally (offline). It will sync automatically when online.`);
    return
   }

   setNotice(`${product.designCode} saved locally. Uploading to cloud in background…`);
   triggerBackgroundUpload();
  }catch(error){
   setNotice(error instanceof Error?`Image could not be saved on this device: ${error.message}`:'Image could not be saved on this device.')
  }
 }
  const handleSaveEdit=async(updated:Product)=>{
   try{
    await storage.updateProduct(updated)
    await load()
    setNotice(`${updated.designCode} updated successfully.`)
    const saved=sessionStorage.getItem(sessionKey)
    const token=saved?(JSON.parse(saved) as {token:string}).token:''
    if(navigator.onLine&&token){triggerBackgroundUpload()}
   }catch(err){setNotice(err instanceof Error?`Failed to update design: ${err.message}`:'Failed to update design.')}
  }
  const handleConfirmArchive=async(product:Product)=>{
   try{
    await storage.archiveProduct(product.id)
    await load()
    setNotice(`${product.designCode} archived. You can view or restore it in Catalogue Administration.`)
    const saved=sessionStorage.getItem(sessionKey)
    const token=saved?(JSON.parse(saved) as {token:string}).token:''
    if(navigator.onLine&&token){triggerBackgroundUpload()}
   }catch(err){setNotice(err instanceof Error?`Failed to archive design: ${err.message}`:'Failed to archive design.')}
  }
  const handleRestoreProduct=async(product:Product)=>{
   try{
    await storage.restoreProduct(product.id)
    await load()
    setNotice(`${product.designCode} restored to active catalogue.`)
    const saved=sessionStorage.getItem(sessionKey)
    const token=saved?(JSON.parse(saved) as {token:string}).token:''
    if(navigator.onLine&&token){triggerBackgroundUpload()}
   }catch(err){setNotice(err instanceof Error?`Failed to restore design: ${err.message}`:'Failed to restore design.')}
  }

  const handleUpdateVendor = async (updated: Vendor) => {
    try {
      await storage.updateVendor(updated)
      await load()
      const token = getStoredToken();
      if (navigator.onLine && token) {
        try {
          const res = await workerApi<Vendor>('/vendors', { method: 'POST', token, body: updated });
          if (res && res.id && res.id !== updated.id) {
            await storage.remapVendorId(updated.id, res.id, res);
          }
          const pending = (await storage.pendingOperations()).find(op => op.entity_type === 'vendor' && ((JSON.parse(op.payload || '{}') as { id?: string }).id === updated.id));
          if (pending) {
            await storage.completeOperation(pending.id);
          }
          await load();
          setNotice(`Vendor "${updated.name}" updated locally and synced to cloud.`);
          return;
        } catch {
          triggerBackgroundUpload();
          setNotice(`Vendor "${updated.name}" updated locally. Cloud sync pending.`);
          return;
        }
      }
      setNotice(`Vendor "${updated.name}" updated locally (offline). It will sync automatically when online.`);
    } catch (err) {
      setNotice(err instanceof Error ? `Failed to update vendor: ${err.message}` : 'Failed to update vendor.')
    }
  }
  const handleArchiveVendor = async (vendor: Vendor) => {
   try {
     await storage.archiveVendor(vendor.id)
     await load()
     setNotice(`Vendor "${vendor.name}" archived. You can restore it anytime in the Archived Vendors tab.`)
     triggerBackgroundUpload()
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to archive vendor: ${err.message}` : 'Failed to archive vendor.')
   }
  }
  const handleRestoreVendor = async (id: string) => {
   try {
     await storage.restoreVendor(id)
     await load()
     setNotice('Vendor restored to active vendor directory.')
     triggerBackgroundUpload()
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to restore vendor: ${err.message}` : 'Failed to restore vendor.')
   }
  }

  const handleUpdateCategory = async (updated: Category) => {
   try {
     await storage.updateCategory(updated)
     await load()
     setNotice(`Category "${updated.name}" updated successfully.`)
     triggerBackgroundUpload()
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to update category: ${err.message}` : 'Failed to update category.')
   }
  }
  const handleArchiveCategory = async (id: string) => {
   try {
     const res = await storage.archiveCategory(id)
     if (!res.ok) {
       setNotice(res.reason || 'Cannot archive category.')
       return
     }
     await load()
     setNotice('Category archived successfully.')
     triggerBackgroundUpload()
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to archive category: ${err.message}` : 'Failed to archive category.')
   }
  }
  const handleRestoreCategory = async (id: string) => {
   try {
     await storage.restoreCategory(id)
     await load()
     setNotice('Category restored to active taxonomy.')
     triggerBackgroundUpload()
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to restore category: ${err.message}` : 'Failed to restore category.')
   }
  }

  const handleUpdateSubcategory = async (updated: Subcategory) => {
   try {
     await storage.updateSubcategory(updated)
     await load()
     setNotice(`Subcategory "${updated.name}" updated successfully.`)
     triggerBackgroundUpload()
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to update subcategory: ${err.message}` : 'Failed to update subcategory.')
   }
  }
  const handleArchiveSubcategory = async (id: string) => {
   try {
     const res = await storage.archiveSubcategory(id)
     if (!res.ok) {
       setNotice(res.reason || 'Cannot archive subcategory.')
       return
     }
     await load()
     setNotice('Subcategory archived successfully.')
     triggerBackgroundUpload()
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to archive subcategory: ${err.message}` : 'Failed to archive subcategory.')
   }
  }
  const handleRestoreSubcategory = async (id: string) => {
   try {
     await storage.restoreSubcategory(id)
     await load()
     setNotice('Subcategory restored to active taxonomy.')
     triggerBackgroundUpload()
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to restore subcategory: ${err.message}` : 'Failed to restore subcategory.')
   }
  }

 const addCategory=async(c:Category)=>{await storage.saveCategory(c);await load();triggerBackgroundUpload()}
 const addSubcategory=async(s:Subcategory)=>{await storage.saveSubcategory(s);await load();triggerBackgroundUpload()}
 const cart=products.filter(p=>selected[p.id]); const total=cart.reduce((n,p)=>n+p.weightMg*selected[p.id].quantity,0)
 if(!session)return <Login onSession={setSession}/>
 const commonViews:View[]=['catalogue','history','vendors','products','batch','taxonomy','storage']
 const views=(session.role==='ADMIN'?[...commonViews,'devices']:commonViews) as View[]
  const logout=()=>{sessionStorage.removeItem(sessionKey);localStorage.removeItem(sessionKey);void storage.clearSession();setSession(null)}
  return <div className="app-shell"><header><div className="brand"><span className="mark">S</span><div><strong>shine jewels</strong><small>{session.role==='ADMIN'?'administrator':'sales catalogue'}</small></div></div><div className="session-actions"><div className="connection" style={{color:online?((syncing||uploading)?'var(--gold)':'var(--green)'):'var(--muted)'}}><i style={{background:online?((syncing||uploading)?'var(--gold)':'var(--green)'):'var(--muted)'}}/> {online?((syncing||uploading)?(syncing?'Syncing…':'Uploading…'):`Online · ${session.displayName}`):`Offline · ${session.displayName}`}</div><button className="quiet logout" onClick={logout}>Log out</button></div></header>
  <nav aria-label="Primary navigation">{views.map(item=><button key={item} className={view===item?'active':''} onClick={()=>setView(item)}>{item}</button>)}</nav>
  {notice&&<div className="notice" role="status">{notice}<button onClick={()=>setNotice('')} aria-label="Dismiss message">×</button></div>}
  <main className="catalogue-layout" style={{display:view==='catalogue'?undefined:'none'}}><section className="catalogue"><div className="section-title"><div><p className="eyebrow">design library</p><h1>Find the right piece, without waiting.</h1></div><span>{filtered.length} designs</span></div><div className="filters"><label>Search design code<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="e.g. SJ-1001" /></label><label>Category<select value={category} onChange={e=>{setCategory(e.target.value);setSubcategory('')}}><option value="">All categories</option>{categories.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label>Subcategory<select value={subcategory} onChange={e=>setSubcategory(e.target.value)}><option value="">All subcategories</option>{subcategories.filter(s=>!category||s.categoryId===category).map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label><button className="quiet" onClick={clearFilters}>Clear filters</button></div>
  <div className="weight-filter-bar"><div className="weight-slider-group"><div className="weight-slider-header"><span>Weight Range Slider</span><span>{currentMinVal} g &mdash; {currentMaxVal} g</span></div><div className="dual-slider-track-box"><div className="dual-slider-rail" /><div className="dual-slider-fill" style={{left:`${leftPercent}%`,width:`${widthPercent}%`}} /><input aria-label="Minimum weight slider" className="dual-slider-thumb" type="range" min={0} max={maxPossibleWeight} step={1} value={currentMinVal} onPointerDown={()=>setSliderActive('min')} onChange={onSliderMinChange} style={{zIndex:sliderActive==='min'?5:(currentMinVal>maxPossibleWeight-5?5:3)}} /><input aria-label="Maximum weight slider" className="dual-slider-thumb" type="range" min={0} max={maxPossibleWeight} step={1} value={currentMaxVal} onPointerDown={()=>setSliderActive('max')} onChange={onSliderMaxChange} style={{zIndex:sliderActive==='max'?5:4}} /></div></div><div className="weight-presets" role="group" aria-label="Quick weight presets"><button type="button" className={`weight-preset-btn ${!minWeight&&!maxWeight?'active':''}`} onClick={()=>applyWeightPreset('','')}>All</button><button type="button" className={`weight-preset-btn ${minWeight===''&&maxWeight==='5'?'active':''}`} onClick={()=>applyWeightPreset('','5')}>&lt; 5g</button><button type="button" className={`weight-preset-btn ${minWeight==='5'&&maxWeight==='15'?'active':''}`} onClick={()=>applyWeightPreset('5','15')}>5&ndash;15g</button><button type="button" className={`weight-preset-btn ${minWeight==='15'&&maxWeight==='30'?'active':''}`} onClick={()=>applyWeightPreset('15','30')}>15&ndash;30g</button><button type="button" className={`weight-preset-btn ${minWeight==='30'&&maxWeight===''?'active':''}`} onClick={()=>applyWeightPreset('30','')}>30g+</button></div><div className="weight-inputs"><label>Min (g)<input type="number" step="0.001" min="0" placeholder="0.000" value={minWeight} onChange={e=>setMinWeight(e.target.value)} /></label><span>to</span><label>Max (g)<input type="number" step="0.001" min="0" placeholder="Max" value={maxWeight} onChange={e=>setMaxWeight(e.target.value)} /></label></div></div>
  <div className="grid">{visibleProducts.map(product=><article className={'product '+(selected[product.id]?'chosen':'')} key={product.id}><button className="image-button" onClick={()=>setDetail(product)} aria-label={`View ${product.designCode}`}><img src={product.gridImage} alt={`${product.designCode} jewelry design`} loading="lazy" decoding="async" /></button><div className="product-meta"><div><strong>{product.designCode}</strong><span>{grams(product.weightMg)} g</span></div><button className="select" aria-pressed={Boolean(selected[product.id])} onClick={()=>toggle(product.id)}>{selected[product.id]?'Selected':'Select'}</button></div></article>)}</div>{visibleCount<filtered.length&&<div ref={sentinelRef} style={{height:'1px',width:'100%',pointerEvents:'none',margin:0,padding:0}} aria-hidden="true"/>}</section><aside className="order-tray"><p className="eyebrow">manufacturer order</p><h2>{cart.length?`${cart.length} designs selected`:'Start with a vendor'}</h2><label>Vendor<select value={vendorId} onChange={e=>setVendorId(e.target.value)}><option value="">Choose vendor</option>{vendors.map(v=><option value={v.id} key={v.id}>{v.name} · {v.city}</option>)}</select></label><div className="line"/>{cart.length===0?<p className="muted">Select designs from the catalogue. Your work stays on this device when offline.</p>:<div className="cart">{cart.map(p=><div className="cart-item" key={p.id}><img src={p.gridImage} alt="" /><div><strong>{p.designCode}</strong><span>{grams(p.weightMg)} g</span><label>Qty<input aria-label={`Quantity for ${p.designCode}`} type="number" min="1" step="1" value={selected[p.id].quantity} onChange={e=>change(p.id,'quantity',e.target.value)} /></label><input aria-label={`Remark for ${p.designCode}`} value={selected[p.id].remark} onChange={e=>change(p.id,'remark',e.target.value)} placeholder="Optional remark" /></div></div>)}</div>}<div className="total"><span>Total weight</span><strong>{grams(total)} g</strong></div><button className="primary" disabled={generatingPdf} onClick={()=>void makeOrder()}>{generatingPdf?'Generating PDF preview…':'Finalize & generate PDF'}</button><small>PDF is generated locally. Cloud sync follows when connected.</small></aside></main>
  {view==='vendors'&&(
   <main className="single-view">
    <div className="section-title">
     <div>
      <p className="eyebrow">vendor directory</p>
      <h1>Vendors for every order.</h1>
     </div>
     <span>{vendors.filter(v=>!v.deleted).length} active · {archivedVendorsList.length} archived</span>
    </div>

    <div className="catalogue-admin-tabs">
     <button
      type="button"
      className={`catalogue-admin-tab ${adminVendorTab==='active'?'active':''}`}
      onClick={()=>setAdminVendorTab('active')}
     >
      Active Vendors <span className="admin-badge">{vendors.filter(v=>!v.deleted).length}</span>
     </button>
     <button
      type="button"
      className={`catalogue-admin-tab ${adminVendorTab==='add'?'active':''}`}
      onClick={()=>setAdminVendorTab('add')}
     >
      + Add New Vendor
     </button>
     <button
      type="button"
      className={`catalogue-admin-tab ${adminVendorTab==='archived'?'active':''}`}
      onClick={()=>setAdminVendorTab('archived')}
     >
      Archived Vendors <span className="admin-badge">{archivedVendorsList.length}</span>
     </button>
    </div>

    {adminVendorTab==='add'&&(
     <div className="management">
      <form onSubmit={addVendor}>
       <h2>Add Vendor</h2>
       <p className="muted" style={{fontSize:'13px',margin:'0 0 var(--space-3)'}}>
        Vendors represent manufacturers and wholesale partners for order generation.
       </p>
       <label>Name<input name="name" required placeholder="e.g. Surat Diamond Works" /></label>
       <label>Business address<input name="address" required placeholder="e.g. 104 Ring Road" /></label>
       <label>City<input name="city" required placeholder="e.g. Surat" /></label>
       <label>Type
        <select name="type">
         <option>WHOLESALE</option>
         <option>RETAIL</option>
         <option>CORPORATE</option>
        </select>
       </label>
       <button className="primary" style={{marginTop:'var(--space-2)'}}>Save Vendor</button>
      </form>
     </div>
    )}

    {adminVendorTab==='active'&&(
     <div>
      <div style={{marginBottom:'var(--space-4)'}}>
       <input
        type="search"
        placeholder="Search active vendors by name or city..."
        value={vendorSearch}
        onChange={e=>setVendorSearch(e.target.value)}
        style={{maxWidth:'360px'}}
       />
      </div>

      <div style={{display:'flex',flexDirection:'column',gap:'var(--space-3)'}}>
       {vendors
        .filter(v=>!v.deleted&&(!vendorSearch||v.name.toLowerCase().includes(vendorSearch.toLowerCase().trim())||v.city.toLowerCase().includes(vendorSearch.toLowerCase().trim())))
        .map(v=>(
         <div key={v.id} className="admin-vendor-card">
          <div className="admin-vendor-card-left">
           <div style={{display:'flex',alignItems:'center',gap:'10px',flexWrap:'wrap'}}>
            <strong>{v.name}</strong>
            <span className="admin-vendor-badge">{v.type || 'WHOLESALE'}</span>
           </div>
           <span>{v.address}, {v.city}</span>
          </div>
          <div style={{display:'flex',gap:'8px',alignItems:'center'}}>
           <button
            type="button"
            className="quiet"
            style={{minHeight:'36px',padding:'0 14px',fontSize:'12px'}}
            onClick={()=>setEditingVendor(v)}
           >
            ✏️ Edit
           </button>
           <button
            type="button"
            className="quiet"
            style={{minHeight:'36px',padding:'0 14px',fontSize:'12px',color:'var(--danger)',borderColor:'var(--danger)'}}
            onClick={()=>setArchivingVendor(v)}
           >
            🗑️ Archive
           </button>
          </div>
         </div>
        ))}
       {vendors.filter(v=>!v.deleted).length===0&&(
        <p className="muted" style={{padding:'20px 0'}}>No active vendors yet. Add a vendor using the &quot;+ Add New Vendor&quot; tab.</p>
       )}
      </div>
     </div>
    )}

    {adminVendorTab==='archived'&&(
     <div>
      <div style={{padding:'12px 16px',background:'var(--gold-soft)',borderRadius:'10px',marginBottom:'var(--space-4)',fontSize:'13px',color:'var(--ink)'}}>
       ℹ️ Archived vendors are hidden from order creation trays, but historical orders, order summaries, and generated manufacturer PDFs retain all vendor details intact. You can restore them anytime.
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:'var(--space-3)'}}>
       {archivedVendorsList.length===0?(
        <p className="muted" style={{padding:'20px 0'}}>No archived vendors.</p>
       ):(
        archivedVendorsList.map(v=>(
         <div key={v.id} className="admin-vendor-card" style={{opacity:0.9}}>
          <div className="admin-vendor-card-left">
           <div style={{display:'flex',alignItems:'center',gap:'10px',flexWrap:'wrap'}}>
            <strong>{v.name}</strong>
            <span className="admin-vendor-badge">{v.type || 'WHOLESALE'}</span>
            <small style={{color:'var(--danger)',fontSize:'11px'}}>Archived</small>
           </div>
           <span>{v.address}, {v.city}</span>
          </div>
          <button
           type="button"
           className="quiet"
           style={{minHeight:'36px',padding:'0 14px',fontSize:'12px',fontWeight:700,color:'var(--green)',borderColor:'var(--green)'}}
           onClick={()=>void handleRestoreVendor(v.id)}
          >
           🔄 Restore Vendor
          </button>
         </div>
        ))
       )}
      </div>
     </div>
    )}

    {editingVendor&&(
     <EditVendorModal
      vendor={editingVendor}
      existingVendors={vendors}
      onSave={handleUpdateVendor}
      onClose={()=>setEditingVendor(null)}
     />
    )}

    {archivingVendor&&(
     <ArchiveVendorModal
      vendor={archivingVendor}
      onConfirm={()=>handleArchiveVendor(archivingVendor)}
      onClose={()=>setArchivingVendor(null)}
     />
    )}
   </main>
  )}
  {view==='products'&&(
   <main className="single-view">
    <div className="section-title">
     <div>
      <p className="eyebrow">catalogue administration</p>
      <h1>Manage designs &amp; active status.</h1>
     </div>
     <span>{products.filter(p=>!p.deleted).length} active · {archivedProductsList.length} archived</span>
    </div>

    <div className="catalogue-admin-tabs">
     <button
      type="button"
      className={`catalogue-admin-tab ${adminProductTab==='active'?'active':''}`}
      onClick={()=>setAdminProductTab('active')}
     >
      Active Designs <span className="admin-badge">{products.filter(p=>!p.deleted).length}</span>
     </button>
     <button
      type="button"
      className={`catalogue-admin-tab ${adminProductTab==='add'?'active':''}`}
      onClick={()=>setAdminProductTab('add')}
     >
      + Add New Design
     </button>
     <button
      type="button"
      className={`catalogue-admin-tab ${adminProductTab==='archived'?'active':''}`}
      onClick={()=>setAdminProductTab('archived')}
     >
      Archived Designs <span className="admin-badge">{archivedProductsList.length}</span>
     </button>
    </div>

    {adminProductTab==='add'&&(
     <ProductEntry categories={categories} subcategories={subcategories} onProduct={stageProduct}/>
    )}

    {adminProductTab==='active'&&(
     <div>
      <div style={{marginBottom:'var(--space-4)'}}>
       <input
        type="search"
        placeholder="Search active designs by code..."
        value={adminSearch}
        onChange={e=>setAdminSearch(e.target.value)}
        style={{maxWidth:'360px'}}
       />
      </div>
      <div className="admin-card-list">
       {products
        .filter(p=>!p.deleted&&(!adminSearch||p.designCode.toLowerCase().includes(adminSearch.toLowerCase().trim())))
        .map(p=>{
         const cat=categories.find(c=>c.id===p.categoryId)?.name||'Jewelry'
         const sub=subcategories.find(s=>s.id===p.subcategoryId)?.name
         return (
          <div key={p.id} className="admin-product-row">
           <div className="admin-product-row-left">
            <img src={p.gridImage} alt={p.designCode}/>
            <div>
             <strong style={{fontSize:'15px'}}>{p.designCode}</strong>
             <span style={{fontSize:'13px',color:'var(--muted)',display:'block'}}>
              {cat}{sub?` / ${sub}`:''} &middot; {grams(p.weightMg)} g
             </span>
             <small style={{color:'var(--gold)',fontSize:'11px'}}>Image v{p.imageVersion||1} &middot; {p.syncState}</small>
            </div>
           </div>
           <div className="admin-product-row-actions">
            <button
             type="button"
             className="quiet"
             style={{minHeight:'36px',padding:'0 12px',fontSize:'12px'}}
             onClick={()=>setEditingProduct(p)}
            >
             ✏️ Edit
            </button>
            <button
             type="button"
             className="quiet"
             style={{minHeight:'36px',padding:'0 12px',fontSize:'12px',color:'var(--danger)',borderColor:'var(--danger)'}}
             onClick={()=>setArchivingProduct(p)}
            >
             🗑️ Archive
            </button>
           </div>
          </div>
         )
        })}
      </div>
     </div>
    )}

    {adminProductTab==='archived'&&(
     <div>
      <div style={{padding:'12px 16px',background:'var(--gold-soft)',borderRadius:'10px',marginBottom:'var(--space-4)',fontSize:'13px',color:'var(--ink)'}}>
       ℹ️ Archived designs are hidden from the active sales catalogue and new orders, but existing orders retain historical snapshots. You can restore them anytime.
      </div>
      <div style={{marginBottom:'var(--space-4)'}}>
       <input
        type="search"
        placeholder="Search archived designs by code..."
        value={adminSearch}
        onChange={e=>setAdminSearch(e.target.value)}
        style={{maxWidth:'360px'}}
       />
      </div>
      <div className="admin-card-list">
       {archivedProductsList.length===0?(
        <p className="muted" style={{padding:'20px 0'}}>No archived designs. All designs in the catalogue are active.</p>
       ):(
        archivedProductsList
         .filter(p=>!adminSearch||p.designCode.toLowerCase().includes(adminSearch.toLowerCase().trim()))
         .map(p=>{
          const cat=categories.find(c=>c.id===p.categoryId)?.name||'Jewelry'
          const sub=subcategories.find(s=>s.id===p.subcategoryId)?.name
          return (
           <div key={p.id} className="admin-product-row" style={{opacity:0.9}}>
            <div className="admin-product-row-left">
             <img src={p.gridImage} alt={p.designCode}/>
             <div>
              <strong style={{fontSize:'15px'}}>{p.designCode}</strong>
              <span style={{fontSize:'13px',color:'var(--muted)',display:'block'}}>
               {cat}{sub?` / ${sub}`:''} &middot; {grams(p.weightMg)} g
              </span>
              <small style={{color:'var(--danger)',fontSize:'11px'}}>Archived / Inactive</small>
             </div>
            </div>
            <div className="admin-product-row-actions">
             <button
              type="button"
              className="quiet"
              style={{minHeight:'36px',padding:'0 14px',fontSize:'12px',fontWeight:700,color:'var(--green)',borderColor:'var(--green)'}}
              onClick={()=>void handleRestoreProduct(p)}
             >
              🔄 Restore to Catalogue
             </button>
            </div>
           </div>
          )
         })
       )}
      </div>
     </div>
    )}
   </main>
  )}
  {view==='batch'&&<main className="single-view"><div className="section-title"><div><p className="eyebrow">queued image workflow</p><h1>Batch design entry</h1></div><span>{products.filter(p=>!p.deleted).length} designs</span></div><BatchEntry categories={categories} subcategories={subcategories} onProduct={stageProduct}/></main>}
  {view==='taxonomy'&&(
   <main className="single-view">
    <Taxonomy
     categories={categories}
     subcategories={subcategories}
     archivedCategoriesList={archivedCategoriesList}
     archivedSubcategoriesList={archivedSubcategoriesList}
     products={products}
     onCategory={addCategory}
     onSubcategory={addSubcategory}
     onUpdateCategory={handleUpdateCategory}
     onUpdateSubcategory={handleUpdateSubcategory}
     onArchiveCategory={handleArchiveCategory}
     onRestoreCategory={handleRestoreCategory}
     onArchiveSubcategory={handleArchiveSubcategory}
     onRestoreSubcategory={handleRestoreSubcategory}
     notice={setNotice}
    />
   </main>
  )}
  {view==='history'&&(
   <main className="single-view">
    <p className="eyebrow">synchronized history</p>
    <h1>Orders retain their original details.</h1>
    <div className="history">
     {orders.length ? (
      orders.map(o => {
       const vObj = (o.vendor as Partial<Vendor> | undefined) || {}
       const raw = o as unknown as Record<string, unknown>
       const vendorName = String(vObj.name || raw.vendor_name_snapshot || raw.vendorName || 'Vendor')
       const orderNum = Number(o.orderNumber || raw.order_number || 0)
       const items = Array.isArray(o.items) ? o.items : []
       const totalQty = items.reduce((n, i) => n + (i.quantity || 0), 0)
       const totalWeight = items.reduce((n, i) => n + (i.weightMg || 0) * (i.quantity || 1), 0)
       const dateStr = new Date(o.generatedAt || o.createdAt || (raw.generated_at as string) || Date.now()).toLocaleString()
       const salesStr = String(o.salesperson || raw.salesperson_id || 'Salesperson')

       return (
        <article key={o.id}>
         <div>
          <strong>#{String(orderNum).padStart(4, '0')} · {vendorName}</strong>
          <span>{dateStr} · {salesStr}</span>
         </div>
         <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <b>{totalQty} pcs · {grams(totalWeight)} g</b>
          <button
           type="button"
           className="quiet"
           style={{ minHeight: '32px', padding: '0 10px', fontSize: '12px' }}
           onClick={() => void openOrderPdfPreview(o)}
           disabled={generatingPdf}
          >
           {generatingPdf ? 'Generating…' : 'Preview & Export PDF'}
          </button>
         </div>
         <details>
          <summary>View design snapshots ({items.length})</summary>
          {items.length ? (
           items.map((i, idx) => (
            <p key={i.productId || idx}>
             {i.designCode || 'Design'} · {i.category || ''}{i.subcategory ? `/${i.subcategory}` : ''} · {i.quantity || 1} × {grams(i.weightMg || 0)} g
            </p>
           ))
          ) : (
           <p className="muted" style={{ padding: '4px 0' }}>Order summary synchronized from cloud.</p>
          )}
         </details>
        </article>
       )
      })
     ) : (
      <p className="muted">No finalized orders on this device yet.</p>
     )}
    </div>
   </main>
  )}
 {view==='storage'&&<main className="single-view storage"><div className="section-title"><div><p className="eyebrow">device replica</p><h1>Storage &amp; synchronization</h1></div><span>Checkpoint #{syncCheckpointVal}</span></div><div className="storage-card"><strong>{cloudBytes===null?'—':(cloudBytes/(1024*1024)).toFixed(2)+' MB'}</strong><span>Cloud R2 catalogue images</span><p>Calculated from the authenticated organization’s confirmed grid/detail image metadata. This is the cloud catalogue total, not a browser cache estimate.</p><strong>{(bytes/(1024*1024)).toFixed(2)} MB</strong><span>This device’s OPFS image replica</span><p>Images saved while working offline are counted here separately and remain on this device until explicitly cleared.</p><div style={{display:'flex',gap:'10px',alignItems:'center',padding:'8px 0'}}><span>Offline queue:</span><strong>{pendingCount} operation(s) pending sync</strong>{pendingCount>0&&<button className="quiet" style={{minHeight:'28px',padding:'0 8px',fontSize:'12px'}} onClick={async()=>{await storage.clearPendingOperations();await load();setNotice('Pending operations queue cleared.')}}>Clear queue</button>}</div><button className="primary" disabled={syncing||!online} onClick={()=>void triggerSync()}>{syncing?'Synchronizing…':'Run Full Synchronization'}</button><button className="quiet" disabled={recovering||!online} onClick={()=>void triggerImageRecovery()}>{recovering?'Recovering images…':'Scan & Recover Missing Images'}</button><button className="quiet" disabled={uploading||!online} onClick={()=>void uploadImages()}>{uploading?'Uploading pending images…':'Upload pending product images'}</button><button className="quiet" onClick={()=>{void load();void loadCloudStorage()}}>Refresh storage estimate</button><button className="quiet" style={{marginTop:'4px'}} onClick={async()=>{if('caches' in window){const k=await caches.keys();await Promise.all(k.map(n=>caches.delete(n)))};if('serviceWorker' in navigator){const regs=await navigator.serviceWorker.getRegistrations();await Promise.all(regs.map(r=>r.unregister()))};window.location.reload()}}>Force Reload &amp; Update App</button></div></main>}
 {view==='devices'&&session.role==='ADMIN'&&<main className="single-view"><div className="section-title"><div><p className="eyebrow">security &amp; administration</p><h1>Authorized Device Sessions</h1></div><span>{devices.length} registered</span></div><div className="records">{devices.map(d=><article key={d.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><div><strong>{d.device_name}</strong><span>Device ID: {d.device_id}</span><small>Last seen: {new Date(d.last_seen_at).toLocaleString()} · Expires: {new Date(d.offline_authorization_expires_at).toLocaleDateString()}</small>{d.revoked_at&&<span style={{color:'var(--danger)'}}>Revoked on {new Date(d.revoked_at).toLocaleString()}</span>}</div>{!d.revoked_at&&<button className="quiet" style={{color:'var(--danger)',borderColor:'var(--danger)'}} onClick={()=>void revokeDevice(d.id)}>Revoke access</button>}</article>)}</div></main>}
  {detail && (
   <div
    className="modal"
    role="dialog"
    aria-modal="true"
    aria-label={`${detail.designCode} details`}
    onTouchStart={handleTouchStart}
    onTouchEnd={handleTouchEnd}
   >
    <button className="close" onClick={() => setDetail(null)} aria-label="Close detail">×</button>
    <div className="modal-stage">
     <button
      type="button"
      className="modal-nav prev"
      onClick={goPrev}
      disabled={!hasPrev}
      aria-label="Previous design"
      title="Previous design (← arrow key)"
     >
      &lsaquo;
     </button>
     <img
      key={detail.id}
      src={resolvedDetailUrl || detail.gridImage}
      alt={`${detail.designCode} detailed jewelry view`}
      loading="eager"
      onError={() => {
        if (resolvedDetailUrl !== detail.gridImage && detail.gridImage) {
          setResolvedDetailUrl(detail.gridImage)
        }
      }}
     />
     <button
      type="button"
      className="modal-nav next"
      onClick={goNext}
      disabled={!hasNext}
      aria-label="Next design"
      title="Next design (→ arrow key)"
     >
      &rsaquo;
     </button>
    </div>
    <div className="modal-info">
     <div className="modal-header-meta">
      <span className="modal-index-badge">
       {activeIndex !== -1 ? `Item ${activeIndex + 1} of ${activeList.length}` : 'Design Preview'}
      </span>
     </div>
     <div>
      <p className="eyebrow">high-resolution detail view</p>
      <h2>{detail.designCode}</h2>
     </div>
     <p style={{ margin: 0, fontSize: '15px', color: 'var(--paper)' }}>
      <strong>{grams(detail.weightMg)} g</strong> &middot; {categories.find(c => c.id === detail.categoryId)?.name || 'Jewelry'}
      {subcategories.find(s => s.id === detail.subcategoryId)?.name ? ` / ${subcategories.find(s => s.id === detail.subcategoryId)?.name}` : ''}
     </p>
     <button
      type="button"
      className="primary"
      style={{ marginTop: 'var(--space-2)' }}
      onClick={() => toggle(detail.id)}
     >
      {selected[detail.id] ? '✓ Selected in Order (Click to Remove)' : '+ Select Design for Order'}
     </button>
    </div>
   </div>
  )}
   {pdfPreview && (
    <div className="pdf-preview-backdrop" role="dialog" aria-modal="true" aria-label="Order PDF Preview">
     <div className="pdf-preview-container">
      <div className="pdf-preview-toolbar">
       <div className="pdf-preview-toolbar-title">
        <strong>{pdfPreview.fileName}</strong>
        <span>
         {(pdfPreview.blob.size / 1024).toFixed(1)} KB &middot; High-Resolution Order Sheet &middot; {pdfPreview.totalQuantity} pcs, {grams(pdfPreview.totalWeightMg)} g
        </span>
       </div>
       <div className="pdf-preview-actions">
        <button
         type="button"
         className="primary"
         onClick={() => downloadPdfBlob(pdfPreview.blob, pdfPreview.fileName)}
        >
         📥 Download PDF
        </button>
        <button
         type="button"
         className="quiet"
         onClick={async () => {
          const shared = await sharePdfFile(pdfPreview.blob, pdfPreview.fileName, pdfPreview.order);
          if (shared) {
           setNotice('PDF shared successfully.');
          } else {
           downloadPdfBlob(pdfPreview.blob, pdfPreview.fileName);
           setNotice('Native sharing not supported on this browser. File downloaded instead.');
          }
         }}
        >
         📤 Share PDF
        </button>
        <button
         type="button"
         className="close"
         onClick={() => {
          URL.revokeObjectURL(pdfPreview.blobUrl);
          setPdfPreview(null);
         }}
         aria-label="Close PDF preview"
        >
         &times;
        </button>
       </div>
      </div>
      <div className="pdf-preview-body">
       <iframe
        className="pdf-preview-embed"
        src={pdfPreview.blobUrl}
        title="PDF Preview"
       />
      </div>
     </div>
    </div>
   )}
   {editingProduct && (
    <EditProductModal
     product={editingProduct}
     categories={categories}
     subcategories={subcategories}
     onSave={handleSaveEdit}
     onClose={() => setEditingProduct(null)}
    />
   )}
   {archivingProduct && (
    <ArchiveConfirmModal
     product={archivingProduct}
     onConfirm={() => handleConfirmArchive(archivingProduct)}
     onClose={() => setArchivingProduct(null)}
    />
   )}
  <footer>Built by Aadit Mehta, contact mail: <a href="mailto:aaditbusiness15@gmail.com">aaditbusiness15@gmail.com</a></footer></div>
}
