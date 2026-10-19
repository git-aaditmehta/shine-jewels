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
import { createBothOrderPdfs, createSalesDemoPdfBlob, downloadPdfBlob, sharePdfFile, type GeneratedPdfResult } from './pdf'
import { storage } from './storage'
import type { Category, DeviceSession, Order, Product, Session, StaffUser, Subcategory, Vendor, VendorRepresentative } from './types'
import { BatchEntry, ProductEntry, Taxonomy } from './Management'
import { EditProductModal, DeleteConfirmModal } from './ProductModals'
import { EditVendorModal, DeleteVendorModal } from './VendorModals'
import { FullscreenViewer } from './FullscreenViewer'

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

function getDeviceName(): string {
  const ua = navigator.userAgent
  let os = 'Unknown Device'
  if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    os = 'iPad'
  } else if (/iPhone/i.test(ua)) {
    os = 'iPhone'
  } else if (/Android/i.test(ua)) {
    os = /Mobile/i.test(ua) ? 'Android Phone' : 'Android Tablet'
  } else if (/Win/i.test(ua)) {
    os = 'Windows PC'
  } else if (/Mac/i.test(ua)) {
    os = 'Mac'
  } else if (/Linux/i.test(ua)) {
    os = 'Linux'
  }

  let browser = 'Browser'
  if (/Edg/i.test(ua)) browser = 'Edge'
  else if (/Chrome/i.test(ua)) browser = 'Chrome'
  else if (/Safari/i.test(ua)) browser = 'Safari'
  else if (/Firefox/i.test(ua)) browser = 'Firefox'

  return `${os} (${browser})`
}

function LogoLightboxModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="logo-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Shine Jewels Emblem Zoom"
      onClick={onClose}
    >
      <div className="logo-lightbox-card" onClick={e => e.stopPropagation()}>
        <button
          type="button"
          className="logo-lightbox-close"
          onClick={onClose}
          aria-label="Close emblem zoom"
        >
          &times;
        </button>
        <div className="logo-lightbox-image-wrap">
          <img
            src="/logo.png"
            className="logo-lightbox-image"
            alt="Shine Jewels Emblem"
          />
        </div>
        <h2 className="logo-lightbox-title">SHINE JEWELS</h2>
        <p className="logo-lightbox-tagline">WE BRING THE SPARKLE YOU MAKE IT SHINE</p>
      </div>
    </div>
  )
}

function Login({onSession}:{onSession:(session:Session)=>void}){
 const [organizationId,setOrganizationId]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[progressMsg,setProgressMsg]=useState('')
 const [logoModalOpen,setLogoModalOpen]=useState(false)
 const submit=async(event:React.FormEvent<HTMLFormElement>)=>{
  event.preventDefault();setError('');setBusy(true);setProgressMsg('Signing in…')
  try{
   const result=await login({organizationId,username,password,deviceId:deviceId(),deviceName:getDeviceName()})
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
 return <>
  <div className="brand-watermark-overlay" aria-hidden="true" />
  {logoModalOpen && <LogoLightboxModal onClose={() => setLogoModalOpen(false)} />}
  <main className="login-shell">
    <section className="login-card" aria-labelledby="login-title">
      <div className="brand login-brand-header">
        <div className="brand-logo-col">
          <div
            className="brand-logo-frame login-logo-frame-large"
            role="button"
            tabIndex={0}
            aria-label="Zoom Shine Jewels emblem"
            title="Click to zoom Shine Jewels emblem"
            onClick={() => setLogoModalOpen(true)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLogoModalOpen(true) } }}
          >
            <img src="/logo.png" className="brand-logo-mark login-logo-large" alt="Shine Jewels Logo" aria-hidden="true" />
          </div>
        </div>
        <div className="brand-info">
          <strong className="brand-wordmark">SHINE JEWELS</strong>
          <small className="brand-tagline">WE BRING THE SPARKLE YOU MAKE IT SHINE</small>
        </div>
      </div>
      <p className="eyebrow">secure access</p>
      <h1 id="login-title">Sign in to your catalogue.</h1>
      <p>Use your organization account to continue.</p>
      <form onSubmit={submit}>
        <label>Organization ID<input value={organizationId} onChange={e=>setOrganizationId(e.target.value)} autoComplete="organization" required /></label>
        <label>Username<input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" required autoFocus /></label>
        <label>Password<input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete="current-password" required /></label>
        {error&&<p className="field-error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy?(progressMsg||'Signing in…'):'Sign in'}</button>
      </form>
    </section>
  </main>
</>
}

export function App(){
 const [session,setSession]=useState<Session|null>(()=>getStoredSession())
 const [products,setProducts]=useState<Product[]>([]),[categories,setCategories]=useState<Category[]>([]),[subcategories,setSubcategories]=useState<Subcategory[]>([]),[vendors,setVendors]=useState<Vendor[]>([]),[orders,setOrders]=useState<Order[]>([])
 const [view,setView]=useState<View>('catalogue'),[query,setQuery]=useState(''),[category,setCategory]=useState(''),[subcategory,setSubcategory]=useState(''),[minWeight,setMinWeight]=useState(''),[maxWeight,setMaxWeight]=useState(''),[sliderActive,setSliderActive]=useState<'min'|'max'>('max'),[selected,setSelected]=useState<Record<string,{quantity:number|'';remark:string}>>({}),[vendorId,setVendorId]=useState(''),[vendorRepresentatives,setVendorRepresentatives]=useState<VendorRepresentative[]>([{name:'',phone:''}]),[notice,setNotice]=useState(''),[detail,setDetail]=useState<Product|null>(null),[generatingPdf,setGeneratingPdf]=useState(false),[bytes,setBytes]=useState(0),[cloudBytes,setCloudBytes]=useState<number|null>(null),[uploading,setUploading]=useState(false),[syncing,setSyncing]=useState(false),[recovering,setRecovering]=useState(false),[syncCheckpointVal,setSyncCheckpointVal]=useState(0),[pendingCount,setPendingCount]=useState(0),[online,setOnline]=useState(navigator.onLine),[devices,setDevices]=useState<DeviceSession[]>([])
 const [logoModalOpen,setLogoModalOpen]=useState(false)
 const [demoMode,setDemoMode]=useState(false)
 const [demoSelected,setDemoSelected]=useState<Record<string,boolean>>({})
 const [orderDrawerOpen,setOrderDrawerOpen]=useState(false)
 const [pdfModal,setPdfModal]=useState<{
   type: 'order' | 'demo'
   orderData?: {
     client: GeneratedPdfResult
     manufacturer: GeneratedPdfResult
     activeCopy: 'client' | 'manufacturer'
   }
   demoPdf?: GeneratedPdfResult
 } | null>(null)
 const [editingProduct,setEditingProduct]=useState<Product|null>(null),[archivingProduct,setArchivingProduct]=useState<Product|null>(null),[archivedProductsList,setArchivedProductsList]=useState<Product[]>([]),[adminProductTab,setAdminProductTab]=useState<'active'|'add'|'archived'>('active'),[adminSearch,setAdminSearch]=useState('')
 const [archivedVendorsList,setArchivedVendorsList]=useState<Vendor[]>([]),[archivedCategoriesList,setArchivedCategoriesList]=useState<Category[]>([]),[archivedSubcategoriesList,setArchivedSubcategoriesList]=useState<Subcategory[]>([])
 const [editingVendor,setEditingVendor]=useState<Vendor|null>(null),[archivingVendor,setArchivingVendor]=useState<Vendor|null>(null),[adminVendorTab,setAdminVendorTab]=useState<'active'|'add'|'archived'>('active'),[vendorSearch,setVendorSearch]=useState(''),[adminDeviceTab,setAdminDeviceTab]=useState<'active'|'staff'|'add_staff'|'all'>('active')
 const [staffList,setStaffList]=useState<StaffUser[]>([])
 const [staffLoading,setStaffLoading]=useState(false)
 const [newStaffUsername,setNewStaffUsername]=useState('')
 const [newStaffPassword,setNewStaffPassword]=useState('')
 const [newStaffDisplayName,setNewStaffDisplayName]=useState('')
 const [showStaffPassword,setShowStaffPassword]=useState(false)
 const [createdStaffCreds,setCreatedStaffCreds]=useState<{username:string;password:string;displayName:string}|null>(null)
 const [staffActionSubmitting,setStaffActionSubmitting]=useState(false)
 const [staffSearchQuery,setStaffSearchQuery]=useState('')
 const [resetPasswordStaff,setResetPasswordStaff]=useState<StaffUser|null>(null)
 const [newResetPasswordValue,setNewResetPasswordValue]=useState('')
 const [showResetPasswordInput,setShowResetPasswordInput]=useState(false)
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
  const loadDevices=async()=>{const token=getStoredToken();if(!token)return;try{const list=await workerApi<DeviceSession[]>('/devices',{token});setDevices(list)}catch(err){setNotice(err instanceof Error?err.message:'Unable to load devices')}}
  const revokeDevice=async(deviceId:string)=>{const token=getStoredToken();if(!token)return;try{await workerApi(`/devices/${deviceId}/revoke`,{method:'POST',token});setNotice('Device session revoked. Device will be logged out upon reconnect.');await loadDevices()}catch(err){setNotice(err instanceof Error?err.message:'Unable to revoke device session')}}
  const deleteDevice=async(deviceId:string)=>{const token=getStoredToken();if(!token)return;try{await workerApi(`/devices/${deviceId}`,{method:'DELETE',token});setNotice('Device session removed.');await loadDevices()}catch(err){setNotice(err instanceof Error?err.message:'Unable to remove device session')}}
  const loadStaff=async()=>{const token=getStoredToken();if(!token)return;setStaffLoading(true);try{const list=await workerApi<StaffUser[]>('/staff',{token});setStaffList(list)}catch(err){setNotice(err instanceof Error?err.message:'Unable to load staff members')}finally{setStaffLoading(false)}}
  const generateStaffPassword=()=>{const words=['Gems','Diamond','Gold','Crown','Sparkle','Shine','Jewel','Emerald'];const w=words[Math.floor(Math.random()*words.length)];const num=Math.floor(1000+Math.random()*9000);return `${w}@${num}`}
  const handleCreateStaff=async(e:React.FormEvent)=>{e.preventDefault();const token=getStoredToken();if(!token)return;const uname=newStaffUsername.trim(),pwd=newStaffPassword.trim(),dname=newStaffDisplayName.trim()||uname;if(uname.length<3){setNotice('Staff username must be at least 3 characters.');return}if(pwd.length<4){setNotice('Staff password must be at least 4 characters.');return}setStaffActionSubmitting(true);try{const res=await workerApi<StaffUser>('/staff',{method:'POST',token,body:{username:uname,password:pwd,displayName:dname}});setCreatedStaffCreds({username:res.username,password:pwd,displayName:res.display_name||dname});setNewStaffUsername('');setNewStaffPassword('');setNewStaffDisplayName('');setNotice(`Staff account "@${res.username}" created successfully.`);await loadStaff()}catch(err){setNotice(err instanceof Error?err.message:'Failed to create staff account')}finally{setStaffActionSubmitting(false)}}
  const handleToggleStaffActive=async(staffId:string)=>{const token=getStoredToken();if(!token)return;try{const res=await workerApi<{id:string;is_active:number}>(`/staff/${staffId}/toggle-active`,{method:'POST',token});setNotice(res.is_active===1?'Staff account activated.':'Staff account suspended and active sessions revoked.');await loadStaff();await loadDevices()}catch(err){setNotice(err instanceof Error?err.message:'Failed to update staff status')}}
  const handleResetStaffPassword=async(e:React.FormEvent)=>{e.preventDefault();if(!resetPasswordStaff)return;const token=getStoredToken();if(!token)return;if(newResetPasswordValue.trim().length<4){setNotice('New password must be at least 4 characters.');return}setStaffActionSubmitting(true);try{await workerApi(`/staff/${resetPasswordStaff.id}/reset-password`,{method:'POST',token,body:{password:newResetPasswordValue.trim()}});setNotice(`Password updated successfully for @${resetPasswordStaff.username}.`);setResetPasswordStaff(null);setNewResetPasswordValue('')}catch(err){setNotice(err instanceof Error?err.message:'Failed to reset password')}finally{setStaffActionSubmitting(false)}}
  const handleDeleteStaff=async(staff:StaffUser)=>{if(!window.confirm(`Are you sure you want to permanently remove staff account "@${staff.username}"? Any active sessions will be terminated.`)){return}const token=getStoredToken();if(!token)return;try{await workerApi(`/staff/${staff.id}`,{method:'DELETE',token});setNotice(`Staff account "@${staff.username}" removed.`);await loadStaff();await loadDevices()}catch(err){setNotice(err instanceof Error?err.message:'Failed to remove staff account')}}
  const triggerSync=async()=>{const token=getStoredToken();if(!token||syncing||!navigator.onLine)return;setSyncing(true);try{const res=await synchronize(token,msg=>setNotice(msg));await load();await loadCloudStorage();setNotice(res.synced?`Sync complete: ${res.uploaded} uploaded, ${res.pulled} change(s) synced.`:'Device is offline.')}catch(err){setNotice(err instanceof Error?`Sync failed: ${err.message}`:'Sync failed.')}finally{setSyncing(false)}}
  const triggerImageRecovery=async()=>{const token=getStoredToken();if(!token||recovering||!navigator.onLine)return;setRecovering(true);try{const res=await recoverMissingImages(token,msg=>setNotice(msg));await load();setNotice(`Recovery complete: ${res.recovered} restored, ${res.failed} unavailable.`)}catch(err){setNotice(err instanceof Error?`Recovery failed: ${err.message}`:'Recovery failed.')}finally{setRecovering(false)}}
  const uploadImages=async()=>{const token=getStoredToken();if(!token||uploading)return;setUploading(true);try{const result=await uploadPendingProductImages(token);await load();await loadCloudStorage();setNotice(result.failed?`${result.uploaded} product image upload(s) completed; ${result.failed} remain queued.`:`${result.uploaded} product image upload(s) completed to R2.`)}catch(error){setNotice(error instanceof Error?`Image upload failed: ${error.message}`:'Image upload failed. Local images remain intact.')}finally{setUploading(false)}}
  const handleResetLocalData=async()=>{
    const confirmed=window.confirm(
      '⚠️ Reset Local Device Data?\n\n' +
      'This will wipe all local test products, categories, vendors, and orders stored in this device\'s offline cache.\n\n' +
      '• Your Admin login and organization session will NOT be deleted.\n' +
      '• You will remain logged in.\n\n' +
      'Do you want to proceed?'
    )
    if(!confirmed)return
    try{
      setNotice('Wiping local device catalogue cache…')
      await storage.resetLocalData()
      if('caches' in window){
        const k=await caches.keys()
        await Promise.all(k.map(n=>caches.delete(n)))
      }
      setNotice('✅ Local device data reset successfully! Admin session intact. Reloading…')
      setTimeout(()=>{
        window.location.reload()
      },700)
    }catch(err){
      setNotice(`Reset failed: ${err instanceof Error?err.message:'Unknown error'}`)
    }
  }
  useEffect(()=>{
    if(!session)return;
    let active=true;
    const init=async()=>{
      const p=await load();
      void loadCloudStorage();
      if(session.role==='ADMIN'){void loadDevices();void loadStaff()}
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
  useEffect(()=>{if(view==='devices'&&session?.role==='ADMIN'){void loadDevices();void loadStaff()}},[view,session?.role])
 const toggle=(id:string)=>setSelected(x=>x[id]?Object.fromEntries(Object.entries(x).filter(([k])=>k!==id)):{...x,[id]:{quantity:'',remark:''}})
 const removeFromOrder=(id:string)=>setSelected(x=>{if(!x[id])return x;const next={...x};delete next[id];return next})
 const change=(id:string,key:'quantity'|'remark',value:string)=>setSelected(s=>({...s,[id]:{...(s[id]||{quantity:1,remark:''}),[key]:key==='quantity'?(value===''? '':Math.max(1,parseInt(value,10)||1)):value}}))
 const updateSelectedItem=(id:string,updates:Partial<{quantity:number|'';remark:string}>)=>setSelected(s=>({...s,[id]:{...(s[id]||{quantity:1,remark:''}),...updates}}))
 const toggleDemoItem=(id:string)=>{
  setDemoSelected(prev=>{
   const next={...prev}
   if(next[id]) delete next[id]
   else next[id]=true
   return next
  })
 }
 const selectAllFilteredForDemo=()=>{
  const allSelected=filtered.length>0&&filtered.every(p=>demoSelected[p.id])
  if(allSelected){
   setDemoSelected(prev=>{
    const next={...prev}
    filtered.forEach(p=>{ delete next[p.id] })
    return next
   })
   setNotice(`Deselected ${filtered.length} designs.`)
  } else {
   setDemoSelected(prev=>{
    const next={...prev}
    filtered.forEach(p=>{ next[p.id]=true })
    return next
   })
   setNotice(`Selected all ${filtered.length} filtered designs for Sales Demo.`)
  }
 }
 const clearDemoSelection=()=>{
  setDemoSelected({})
  setNotice('Cleared Sales Demo selection.')
 }
 const generateSalesDemoPdf=async()=>{
  const demoProducts=products.filter(p=>!p.deleted&&demoSelected[p.id])
  if(!demoProducts.length){
   setNotice('Please select at least one design to generate a Sales Demo PDF.')
   return
  }
  setGeneratingPdf(true)
  setNotice(`Rendering High-Resolution Sales Demo PDF (${demoProducts.length} designs)…`)
  try{
   const demoPdf=await createSalesDemoPdfBlob(
    demoProducts,
    categories,
    subcategories,
    (curr,total)=>setNotice(`Rendering design ${curr} of ${total} in high resolution…`)
   )
   setPdfModal({
    type:'demo',
    demoPdf
   })
   setNotice(`Sales Demo PDF ready: ${demoProducts.length} high-resolution showcase pages.`)
  }catch(err){
   setNotice(err instanceof Error?`Sales Demo PDF failed: ${err.message}`:'Sales Demo PDF generation failed.')
  }finally{
   setGeneratingPdf(false)
  }
 }
 const makeOrder=async()=>{
  const vendor=vendors.find(v=>v.id===vendorId);
  const picks=products.filter(p=>selected[p.id]);
  if(!vendor){setNotice('Select a vendor before reviewing the order.');return}
  if(!picks.length){setNotice('Select at least one design.');return};
  const max=Math.max(0,...orders.map(o=>o.orderNumber||0));
  const cleanedReps=vendorRepresentatives.map(r=>({name:r.name.trim(),phone:r.phone.trim()})).filter(r=>r.name||r.phone);
  const order:Order={id:uid(),orderNumber:max+1,vendor,representatives:cleanedReps.length?cleanedReps:undefined,salesperson:session?.displayName||'Salesperson',status:'FINALIZED',createdAt:new Date().toISOString(),generatedAt:new Date().toISOString(),items:picks.map((p,index)=>({productId:p.id,serialNumber:index+1,designCode:p.designCode,category:categories.find(c=>c.id===p.categoryId)?.name||'',subcategory:subcategories.find(s=>s.id===p.subcategoryId)?.name||'',weightMg:p.weightMg,quantity:Number(selected[p.id].quantity)||1,remark:selected[p.id].remark,image:p.gridImage}))};
  await storage.saveOrder(order);
  setOrders(o=>[order,...o]);
  setSelected({});
  setVendorRepresentatives([{name:'',phone:''}]);
  await load();
  setNotice(`Order #${order.orderNumber} finalized. Generating Client & Manufacturer PDFs…`);
  setGeneratingPdf(true);
  try{
   const { client, manufacturer } = await createBothOrderPdfs(order);
   setPdfModal({
    type: 'order',
    orderData: { client, manufacturer, activeCopy: 'client' }
   });
   setNotice(`Order #${order.orderNumber} ready: Client Copy & Manufacturer Copy generated.`);
  }catch(err){
   setNotice(err instanceof Error?`PDF generation failed: ${err.message}`:'PDF generation failed.')
  }finally{
   setGeneratingPdf(false)
  }
 }
 const openOrderPdfPreview=async(order:Order)=>{
  setGeneratingPdf(true);
  setNotice(`Generating Client & Manufacturer PDFs for Order #${order.orderNumber}…`);
  try{
   const { client, manufacturer } = await createBothOrderPdfs(order);
   setPdfModal({
    type: 'order',
    orderData: { client, manufacturer, activeCopy: 'client' }
   });
   setNotice(`Order #${order.orderNumber} PDFs ready: Client Copy & Manufacturer Copy.`);
  }catch(err){
   setNotice(err instanceof Error?`PDF generation failed: ${err.message}`:'PDF generation failed.')
  }finally{
   setGeneratingPdf(false)
  }
 }
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
    await storage.deleteProduct(product.id)
    await load()
    setNotice(`${product.designCode} permanently deleted from cloud and device.`)
    const token=getStoredToken()
    if(navigator.onLine&&token){
      try{
        await workerApi(`/products/${product.id}`,{method:'DELETE',token})
        const pending=(await storage.pendingOperations()).find(op=>op.entity_type==='product'&&((JSON.parse(op.payload||'{}')as{id?:string}).id===product.id))
        if(pending)await storage.completeOperation(pending.id)
        await load()
      }catch{
        triggerBackgroundUpload()
      }
    }
   }catch(err){setNotice(err instanceof Error?`Failed to delete design: ${err.message}`:'Failed to delete design.')}
  }
  const handleRestoreProduct=async(product:Product)=>{
   try{
    await storage.restoreProduct(product.id)
    await load()
    setNotice(`${product.designCode} restored.`)
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
     await storage.deleteVendor(vendor.id)
     await load()
     setNotice(`Vendor "${vendor.name}" permanently deleted from cloud and device.`)
     const token = getStoredToken()
     if(navigator.onLine&&token){
       try{
         await workerApi(`/vendors/${vendor.id}`,{method:'DELETE',token})
         const pending=(await storage.pendingOperations()).find(op=>op.entity_type==='vendor'&&((JSON.parse(op.payload||'{}')as{id?:string}).id===vendor.id))
         if(pending)await storage.completeOperation(pending.id)
         await load()
       }catch{
         triggerBackgroundUpload()
       }
     }
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to delete vendor: ${err.message}` : 'Failed to delete vendor.')
   }
  }
  const handleRestoreVendor = async (id: string) => {
   try {
     await storage.restoreVendor(id)
     await load()
     setNotice('Vendor restored.')
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
     const res = await storage.deleteCategory(id)
     if (!res.ok) {
       setNotice(res.reason || 'Cannot delete category.')
       return
     }
     await load()
     setNotice('Category permanently deleted.')
     const token = getStoredToken()
     if(navigator.onLine&&token){
       try{
         await workerApi(`/categories/${id}`,{method:'DELETE',token})
         const pending=(await storage.pendingOperations()).find(op=>op.entity_type==='category'&&((JSON.parse(op.payload||'{}')as{id?:string}).id===id))
         if(pending)await storage.completeOperation(pending.id)
         await load()
       }catch{
         triggerBackgroundUpload()
       }
     }
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to delete category: ${err.message}` : 'Failed to delete category.')
   }
  }
  const handleRestoreCategory = async (id: string) => {
   try {
     await storage.restoreCategory(id)
     await load()
     setNotice('Category restored.')
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
     const res = await storage.deleteSubcategory(id)
     if (!res.ok) {
       setNotice(res.reason || 'Cannot delete subcategory.')
       return
     }
     await load()
     setNotice('Subcategory permanently deleted.')
     const token = getStoredToken()
     if(navigator.onLine&&token){
       try{
         await workerApi(`/subcategories/${id}`,{method:'DELETE',token})
         const pending=(await storage.pendingOperations()).find(op=>op.entity_type==='subcategory'&&((JSON.parse(op.payload||'{}')as{id?:string}).id===id))
         if(pending)await storage.completeOperation(pending.id)
         await load()
       }catch{
         triggerBackgroundUpload()
       }
     }
   } catch (err) {
     setNotice(err instanceof Error ? `Failed to delete subcategory: ${err.message}` : 'Failed to delete subcategory.')
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
 const cart=products.filter(p=>selected[p.id]); const total=cart.reduce((n,p)=>n+p.weightMg*(Number(selected[p.id].quantity)||1),0)
 if(!session) return <Login onSession={setSession} />
 const commonViews:View[]=['catalogue','history','vendors','products','batch','taxonomy','storage']
 const views=(session.role==='ADMIN'?[...commonViews,'devices']:commonViews) as View[]
  // Sync view name to body for CSS theme scoping
  useEffect(() => {
    document.body.dataset.view = view
    return () => { delete document.body.dataset.view }
  }, [view])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && orderDrawerOpen) {
        setOrderDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [orderDrawerOpen])

  useEffect(() => {
    if (view !== 'catalogue') setOrderDrawerOpen(false)
  }, [view])

  const logout=()=>{sessionStorage.removeItem(sessionKey);localStorage.removeItem(sessionKey);void storage.clearSession();setSession(null)}
  return <>
  <div className="brand-watermark-overlay" aria-hidden="true" />
  {logoModalOpen && <LogoLightboxModal onClose={() => setLogoModalOpen(false)} />}

  {/* Top-Right Floating Manufacturer Order Icon */}
  {view === 'catalogue' && !detail && (
    <button
      type="button"
      className={`order-floating-trigger ${cart.length > 0 ? 'has-items' : ''} ${orderDrawerOpen ? 'drawer-open' : ''}`}
      onClick={() => setOrderDrawerOpen(open => !open)}
      aria-label={`Manufacturer order: ${cart.length} design(s) selected`}
      title={orderDrawerOpen ? 'Minimize manufacturer order' : `Manufacturer order (${cart.length} designs)`}
    >
      <span className="order-trigger-icon" aria-hidden="true">📋</span>
      <span className="order-trigger-text">Order</span>
      <span className="order-trigger-badge">{cart.length}</span>
    </button>
  )}

  {/* Expandable Manufacturer Order Slide-Over Drawer */}
  {orderDrawerOpen && view === 'catalogue' && (
    <div
      className="order-drawer-backdrop"
      onClick={() => setOrderDrawerOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Manufacturer Order Drawer"
    >
      <div className="order-drawer-panel" onClick={e => e.stopPropagation()}>
        <div className="order-drawer-header">
          <div className="order-drawer-header-info">
            <span className="order-drawer-eyebrow">Manufacturer Order</span>
            <h2 className="order-drawer-title">{cart.length ? `${cart.length} design(s) selected` : 'Start with a vendor'}</h2>
            <span className="order-drawer-subtitle">{cart.length} designs · {grams(total)} g total</span>
          </div>
          <button
            type="button"
            className="order-drawer-minimize-btn"
            onClick={() => setOrderDrawerOpen(false)}
            aria-label="Minimize order drawer"
            title="Minimize order drawer"
          >
            ✕ Minimize
          </button>
        </div>

        <div className="order-drawer-body">
          <label>Vendor
            <select value={vendorId} onChange={e => setVendorId(e.target.value)}>
              <option value="">Choose vendor</option>
              {vendors.map(v => <option value={v.id} key={v.id}>{v.name} · {v.city}</option>)}
            </select>
          </label>

          {vendorId && (
            <div className="order-reps-section">
              <div className="order-reps-header">
                <span className="order-reps-title">Vendor Representative <span className="order-reps-subtitle">(Optional)</span></span>
                <button type="button" className="order-rep-add-btn" onClick={() => setVendorRepresentatives(r => [...r, { name: '', phone: '' }])}>+ Add person</button>
              </div>
              {vendorRepresentatives.map((rep, idx) => (
                <div className="order-rep-card" key={idx}>
                  <div className="order-rep-card-top">
                    <span>Person {idx + 1}</span>
                    {vendorRepresentatives.length > 1 && (
                      <button type="button" className="order-rep-del-btn" aria-label={`Remove representative ${idx + 1}`} onClick={() => setVendorRepresentatives(r => r.filter((_, i) => i !== idx))}>✕ Remove</button>
                    )}
                  </div>
                  <div className="order-rep-fields">
                    <input
                      type="text"
                      placeholder="Name"
                      value={rep.name}
                      aria-label={`Representative ${idx + 1} name`}
                      onChange={e => {
                        const val = e.target.value
                        setVendorRepresentatives(r => r.map((item, i) => i === idx ? { ...item, name: val } : item))
                      }}
                    />
                    <input
                      type="tel"
                      placeholder="Phone number"
                      value={rep.phone}
                      aria-label={`Representative ${idx + 1} phone number`}
                      onChange={e => {
                        const val = e.target.value
                        setVendorRepresentatives(r => r.map((item, i) => i === idx ? { ...item, phone: val } : item))
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="line" />

          {cart.length === 0 ? (
            <p className="muted">Select designs from the catalogue. They will appear here in real time.</p>
          ) : (
            <div className="cart">
              {cart.map(p => (
                <div className="cart-item" key={p.id}>
                  <img src={p.gridImage} alt={p.designCode} />
                  <div className="cart-item-body">
                    <div className="cart-item-header">
                      <div><strong>{p.designCode}</strong><span>{grams(p.weightMg)} g</span></div>
                      <button type="button" className="cart-item-remove-btn" onClick={() => removeFromOrder(p.id)} aria-label={`Remove ${p.designCode} from order`} title={`Remove ${p.designCode} from order`}>✕</button>
                    </div>
                    <label>Qty
                      <input aria-label={`Quantity for ${p.designCode}`} type="number" min="1" step="1" placeholder="1" value={selected[p.id].quantity} onChange={e => change(p.id, 'quantity', e.target.value)} />
                    </label>
                    <input aria-label={`Remark for ${p.designCode}`} value={selected[p.id].remark} onChange={e => change(p.id, 'remark', e.target.value)} placeholder="Optional remark" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="order-drawer-footer">
          <div className="total">
            <span>Total weight</span>
            <strong>{grams(total)} g</strong>
          </div>
          <button
            className="primary"
            disabled={generatingPdf || cart.length === 0}
            onClick={() => {
              setOrderDrawerOpen(false);
              void makeOrder();
            }}
          >
            {generatingPdf ? 'Generating PDF preview…' : 'Finalize & generate PDF'}
          </button>
          <small className="muted" style={{ textAlign: 'center', fontSize: '11px' }}>
            PDF is generated locally. Cloud sync follows when connected.
          </small>
        </div>
      </div>
    </div>
  )}

  <div className="app-shell">
    <header>
      <div className="brand">
        <div className="brand-logo-col">
          <div
            className="brand-logo-frame"
            role="button"
            tabIndex={0}
            aria-label="Zoom Shine Jewels emblem"
            title="Click to zoom Shine Jewels emblem"
            onClick={() => setLogoModalOpen(true)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLogoModalOpen(true) } }}
          >
            <img src="/logo.png" className="brand-logo-mark" alt="Shine Jewels Logo" aria-hidden="true" />
          </div>
          {session.role === 'ADMIN' && <span className="brand-role-bracket">(admin)</span>}
        </div>
        <div className="brand-info">
          <strong className="brand-wordmark">SHINE JEWELS</strong>
          <small className="brand-tagline">WE BRING THE SPARKLE YOU MAKE IT SHINE</small>
        </div>
      </div>
      <div className="session-actions">
        {view === 'catalogue' && (
          <button
            type="button"
            className={`header-order-btn ${cart.length > 0 ? 'has-items' : ''}`}
            onClick={() => setOrderDrawerOpen(true)}
            aria-label={`Manufacturer order: ${cart.length} design(s)`}
            title={`View manufacturer order (${cart.length} designs)`}
          >
            <span aria-hidden="true">📋</span>
            <span className="header-order-text">Order</span>
            <span className="header-order-badge">{cart.length}</span>
          </button>
        )}
        <div className="connection" style={{color:online?((syncing||uploading)?'var(--gold)':'var(--green)'):'var(--muted)'}}>
          <i style={{background:online?((syncing||uploading)?'var(--gold)':'var(--green)'):'var(--muted)'}}/> {online?((syncing||uploading)?(syncing?'Syncing…':'Uploading…'):`Online · ${session.displayName}`):`Offline · ${session.displayName}`}
        </div>
        <button className="quiet logout" onClick={logout}>Log out</button>
      </div>
    </header>
  <nav aria-label="Primary navigation">{views.map(item=><button key={item} className={view===item?'active':''} onClick={()=>setView(item)}>{item}</button>)}</nav>
  {notice&&<div className="notice" role="status">{notice}<button onClick={()=>setNotice('')} aria-label="Dismiss message">×</button></div>}
  <main className="catalogue-layout" style={{display:view==='catalogue'?undefined:'none'}}><section className="catalogue"><div className="section-title"><div><p className="eyebrow">design library</p><h1>Find the right piece, without waiting.</h1></div><div style={{display:'flex',gap:'10px',alignItems:'center'}}><span>{filtered.length} designs</span><button type="button" className={`sales-demo-toggle-btn ${demoMode?'active':''}`} onClick={()=>setDemoMode(m=>!m)} title="Create high-resolution product demo PDF">✨ {demoMode?'Exit Demo Mode':'Sales Demo PDF'}</button></div></div><div className="filters"><label>Search design code<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="e.g. SJ-1001" /></label><label>Category<select value={category} onChange={e=>{setCategory(e.target.value);setSubcategory('')}}><option value="">All categories</option>{categories.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label>Subcategory<select value={subcategory} onChange={e=>setSubcategory(e.target.value)}><option value="">All subcategories</option>{subcategories.filter(s=>!category||s.categoryId===category).map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label><button className="quiet" onClick={clearFilters}>Clear filters</button></div>
  <div className="weight-filter-bar"><div className="weight-slider-group"><div className="weight-slider-header"><span>Weight Range Slider</span><span>{currentMinVal} g &mdash; {currentMaxVal} g</span></div><div className="dual-slider-track-box"><div className="dual-slider-rail" /><div className="dual-slider-fill" style={{left:`${leftPercent}%`,width:`${widthPercent}%`}} /><input aria-label="Minimum weight slider" className="dual-slider-thumb" type="range" min={0} max={maxPossibleWeight} step={1} value={currentMinVal} onPointerDown={()=>setSliderActive('min')} onChange={onSliderMinChange} style={{zIndex:sliderActive==='min'?5:(currentMinVal>maxPossibleWeight-5?5:3)}} /><input aria-label="Maximum weight slider" className="dual-slider-thumb" type="range" min={0} max={maxPossibleWeight} step={1} value={currentMaxVal} onPointerDown={()=>setSliderActive('max')} onChange={onSliderMaxChange} style={{zIndex:sliderActive==='max'?5:4}} /></div></div><div className="weight-presets" role="group" aria-label="Quick weight presets"><button type="button" className={`weight-preset-btn ${!minWeight&&!maxWeight?'active':''}`} onClick={()=>applyWeightPreset('','')}>All</button><button type="button" className={`weight-preset-btn ${minWeight===''&&maxWeight==='5'?'active':''}`} onClick={()=>applyWeightPreset('','5')}>&lt; 5g</button><button type="button" className={`weight-preset-btn ${minWeight==='5'&&maxWeight==='15'?'active':''}`} onClick={()=>applyWeightPreset('5','15')}>5&ndash;15g</button><button type="button" className={`weight-preset-btn ${minWeight==='15'&&maxWeight==='30'?'active':''}`} onClick={()=>applyWeightPreset('15','30')}>15&ndash;30g</button><button type="button" className={`weight-preset-btn ${minWeight==='30'&&maxWeight===''?'active':''}`} onClick={()=>applyWeightPreset('30','')}>30g+</button></div><div className="weight-inputs"><label>Min (g)<input type="number" step="0.001" min="0" placeholder="0.000" value={minWeight} onChange={e=>setMinWeight(e.target.value)} /></label><span>to</span><label>Max (g)<input type="number" step="0.001" min="0" placeholder="Max" value={maxWeight} onChange={e=>setMaxWeight(e.target.value)} /></label></div></div>
  {demoMode&&(
    <div className="sales-demo-bar" role="region" aria-label="Sales Demo PDF Toolbar">
      <div className="sales-demo-bar-left">
        <span className="sales-demo-badge">✨ Sales Demo Mode</span>
        <span className="sales-demo-count">{Object.keys(demoSelected).length} design(s) selected</span>
        {filtered.length>0&&(
          <button type="button" className="quiet" style={{fontSize:'12px',padding:'4px 10px'}} onClick={selectAllFilteredForDemo}>
            {filtered.every(p=>demoSelected[p.id])?'✕ Deselect Filtered':`✓ Select All Filtered (${filtered.length})`}
          </button>
        )}
        {Object.keys(demoSelected).length>0&&(
          <button type="button" className="quiet" style={{fontSize:'12px',padding:'4px 10px'}} onClick={clearDemoSelection}>
            Clear Selection
          </button>
        )}
      </div>
      <div className="sales-demo-bar-actions">
        <button
          type="button"
          className="sales-demo-btn-primary"
          disabled={generatingPdf||Object.keys(demoSelected).length===0}
          onClick={()=>void generateSalesDemoPdf()}
        >
          {generatingPdf?'Rendering High-Res PDF…':`📄 Generate Demo PDF (${Object.keys(demoSelected).length})`}
        </button>
        <button type="button" className="quiet" style={{fontSize:'12px',padding:'4px 10px'}} onClick={()=>setDemoMode(false)}>
          ✕ Close
        </button>
      </div>
    </div>
  )}
  <div className="grid">{visibleProducts.map(product=><article className={'product '+((selected[product.id]||demoSelected[product.id])?'chosen':'')} key={product.id}>{demoMode&&(<button type="button" className={`product-demo-badge ${demoSelected[product.id]?'selected':''}`} onClick={(e)=>{e.stopPropagation();toggleDemoItem(product.id)}} title={demoSelected[product.id]?'Remove from Sales Demo':'Include in Sales Demo'}>{demoSelected[product.id]?'✓ In Demo':'+ Add to Demo'}</button>)}<button className="image-button" onClick={()=>setDetail(product)} aria-label={`View ${product.designCode}`}><img src={product.gridImage} alt={`${product.designCode} jewelry design`} loading="lazy" decoding="async" /></button><div className="product-meta"><div><strong>{product.designCode}</strong><span>{grams(product.weightMg)} g</span></div>{demoMode?(<button className={`select ${demoSelected[product.id]?'active-demo':''}`} aria-pressed={Boolean(demoSelected[product.id])} onClick={()=>toggleDemoItem(product.id)}>{demoSelected[product.id]?'✓ In Demo':'Select for Demo'}</button>):(<button className="select" aria-pressed={Boolean(selected[product.id])} onClick={()=>toggle(product.id)}>{selected[product.id]?'Selected':'Select'}</button>)}</div></article>)}</div>{visibleCount<filtered.length&&<div ref={sentinelRef} style={{height:'1px',width:'100%',pointerEvents:'none',margin:0,padding:0}} aria-hidden="true"/>}</section><aside className="order-tray"><p className="eyebrow">manufacturer order</p><h2>{cart.length?`${cart.length} designs selected`:'Start with a vendor'}</h2><label>Vendor<select value={vendorId} onChange={e=>setVendorId(e.target.value)}><option value="">Choose vendor</option>{vendors.map(v=><option value={v.id} key={v.id}>{v.name} · {v.city}</option>)}</select></label>{vendorId&&(
<div className="order-reps-section">
 <div className="order-reps-header">
  <span className="order-reps-title">Vendor Representative <span className="order-reps-subtitle">(Optional)</span></span>
  <button type="button" className="order-rep-add-btn" onClick={()=>setVendorRepresentatives(r=>[...r,{name:'',phone:''}])}>+ Add person</button>
 </div>
 {vendorRepresentatives.map((rep,idx)=>(
  <div className="order-rep-card" key={idx}>
   <div className="order-rep-card-top">
    <span>Person {idx+1}</span>
    {vendorRepresentatives.length>1&&(
     <button type="button" className="order-rep-del-btn" aria-label={`Remove representative ${idx+1}`} onClick={()=>setVendorRepresentatives(r=>r.filter((_,i)=>i!==idx))}>✕ Remove</button>
    )}
   </div>
   <div className="order-rep-fields">
    <input
     type="text"
     placeholder="Name"
     value={rep.name}
     aria-label={`Representative ${idx+1} name`}
     onChange={e=>{
      const val=e.target.value
      setVendorRepresentatives(r=>r.map((item,i)=>i===idx?{...item,name:val}:item))
     }}
    />
    <input
     type="tel"
     placeholder="Phone number"
     value={rep.phone}
     aria-label={`Representative ${idx+1} phone number`}
     onChange={e=>{
      const val=e.target.value
      setVendorRepresentatives(r=>r.map((item,i)=>i===idx?{...item,phone:val}:item))
     }}
    />
   </div>
  </div>
 ))}
</div>
)}<div className="line"/>{cart.length===0?<p className="muted">Select designs from the catalogue. Your work stays on this device when offline.</p>:<div className="cart">{cart.map(p=><div className="cart-item" key={p.id}><img src={p.gridImage} alt={p.designCode} /><div className="cart-item-body"><div className="cart-item-header"><div><strong>{p.designCode}</strong><span>{grams(p.weightMg)} g</span></div><button type="button" className="cart-item-remove-btn" onClick={()=>removeFromOrder(p.id)} aria-label={`Remove ${p.designCode} from order`} title={`Remove ${p.designCode} from order`}>✕</button></div><label>Qty<input aria-label={`Quantity for ${p.designCode}`} type="number" min="1" step="1" placeholder="1" value={selected[p.id].quantity} onChange={e=>change(p.id,'quantity',e.target.value)} /></label><input aria-label={`Remark for ${p.designCode}`} value={selected[p.id].remark} onChange={e=>change(p.id,'remark',e.target.value)} placeholder="Optional remark" /></div></div>)}</div>}<div className="total"><span>Total weight</span><strong>{grams(total)} g</strong></div><button className="primary" disabled={generatingPdf} onClick={()=>void makeOrder()}>{generatingPdf?'Generating PDF preview…':'Finalize & generate PDF'}</button><small>PDF is generated locally. Cloud sync follows when connected.</small></aside></main>
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
     <DeleteVendorModal
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
             🗑️ Delete
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
  {view==='storage'&&<main className="single-view storage"><div className="section-title"><div><p className="eyebrow">device replica</p><h1>Storage &amp; synchronization</h1></div><span>Checkpoint #{syncCheckpointVal}</span></div><div className="storage-card"><strong>{cloudBytes===null?'—':(cloudBytes/(1024*1024)).toFixed(2)+' MB'}</strong><span>Cloud R2 catalogue images</span><p>Calculated from the authenticated organization’s confirmed grid/detail image metadata. This is the cloud catalogue total, not a browser cache estimate.</p><strong>{(bytes/(1024*1024)).toFixed(2)} MB</strong><span>This device’s OPFS image replica</span><p>Images saved while working offline are counted here separately and remain on this device until explicitly cleared.</p><div style={{display:'flex',gap:'10px',alignItems:'center',padding:'8px 0'}}><span>Offline queue:</span><strong>{pendingCount} operation(s) pending sync</strong>{pendingCount>0&&<button className="quiet" style={{minHeight:'28px',padding:'0 8px',fontSize:'12px'}} onClick={async()=>{await storage.clearPendingOperations();await load();setNotice('Pending operations queue cleared.')}}>Clear queue</button>}</div><button className="primary" disabled={syncing||!online} onClick={()=>void triggerSync()}>{syncing?'Synchronizing…':'Run Full Synchronization'}</button><button className="quiet" disabled={recovering||!online} onClick={()=>void triggerImageRecovery()}>{recovering?'Recovering images…':'Scan & Recover Missing Images'}</button><button className="quiet" disabled={uploading||!online} onClick={()=>void uploadImages()}>{uploading?'Uploading pending images…':'Upload pending product images'}</button><button className="quiet" onClick={()=>{void load();void loadCloudStorage()}}>Refresh storage estimate</button><button className="quiet" style={{marginTop:'4px'}} onClick={async()=>{if('caches' in window){const k=await caches.keys();await Promise.all(k.map(n=>caches.delete(n)))};if('serviceWorker' in navigator){const regs=await navigator.serviceWorker.getRegistrations();await Promise.all(regs.map(r=>r.unregister()))};window.location.reload()}}>Force Reload &amp; Update App</button><div style={{marginTop:'20px',paddingTop:'16px',borderTop:'1px dashed var(--danger,#983b32)'}}><strong style={{color:'var(--danger,#983b32)',fontSize:'13px',display:'block',marginBottom:'4px'}}>⚠️ Clean Handover Tool (Temporary)</strong><p style={{fontSize:'12px',color:'var(--muted)',margin:'0 0 10px'}}>Wipes all local test products, categories, vendors, and orders cached on this device so the client starts completely fresh. <strong>Your Admin login session is preserved.</strong></p><button type="button" className="quiet" style={{minHeight:'42px',width:'100%',color:'#fff',background:'var(--danger,#983b32)',borderColor:'var(--danger,#983b32)',fontWeight:700,fontSize:'13px',borderRadius:'8px'}} onClick={handleResetLocalData}>🗑️ Wipe Local Device Data (Keep Admin Logged In)</button></div></div></main>}
 {view==='devices'&&session.role==='ADMIN'&&(
  <main className="single-view">
   <div className="section-title">
    <div>
     <p className="eyebrow">security &amp; staff administration</p>
     <h1>Authorized Devices &amp; Staff Access</h1>
    </div>
    <span>
     {devices.filter(d=>!d.revoked_at && new Date(d.offline_authorization_expires_at) > new Date()).length} active device(s) · {staffList.length} staff member(s)
    </span>
   </div>

   <div className="catalogue-admin-tabs">
    <button
     type="button"
     className={`catalogue-admin-tab ${adminDeviceTab==='active'?'active':''}`}
     onClick={()=>setAdminDeviceTab('active')}
    >
     Active Staff &amp; Devices <span className="admin-badge">{devices.filter(d=>!d.revoked_at && new Date(d.offline_authorization_expires_at) > new Date()).length}</span>
    </button>
    <button
     type="button"
     className={`catalogue-admin-tab ${adminDeviceTab==='staff'?'active':''}`}
     onClick={()=>setAdminDeviceTab('staff')}
    >
     Staff Accounts <span className="admin-badge">{staffList.length}</span>
    </button>
    <button
     type="button"
     className={`catalogue-admin-tab ${adminDeviceTab==='add_staff'?'active':''}`}
     onClick={()=>setAdminDeviceTab('add_staff')}
    >
     + Add Staff Account
    </button>
    <button
     type="button"
     className={`catalogue-admin-tab ${adminDeviceTab==='all'?'active':''}`}
     onClick={()=>setAdminDeviceTab('all')}
    >
     All Sessions <span className="admin-badge">{devices.length}</span>
    </button>
   </div>

   {adminDeviceTab === 'add_staff' && (
     <div className="staff-create-container">
       {createdStaffCreds ? (
         <div className="staff-creds-callout">
           <h3>✅ Staff Account Created Successfully!</h3>
           <p style={{ margin: 0, fontSize: '13px' }}>Share these credentials with the staff member so they can sign into the application:</p>
           <div className="staff-creds-box">
             <div className="staff-creds-row"><span>Organization ID:</span> <code>{session.organizationId}</code></div>
             <div className="staff-creds-row"><span>Staff Name:</span> <strong>{createdStaffCreds.displayName}</strong></div>
             <div className="staff-creds-row"><span>Staff Username:</span> <code>{createdStaffCreds.username}</code></div>
             <div className="staff-creds-row"><span>Staff Password:</span> <code>{createdStaffCreds.password}</code></div>
           </div>
           <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
             <button
               type="button"
               className="primary"
               style={{ width: 'auto', minHeight: '38px', padding: '0 16px', marginTop: 0 }}
               onClick={() => {
                 const text = `Shine Jewels Sign-In Details:\nOrganization ID: ${session.organizationId}\nUsername: ${createdStaffCreds.username}\nPassword: ${createdStaffCreds.password}`
                 void navigator.clipboard.writeText(text)
                 setNotice('Sign-in details copied to clipboard!')
               }}
             >
               📋 Copy Login Details
             </button>
             <button
               type="button"
               className="quiet"
               style={{ minHeight: '38px', padding: '0 14px' }}
               onClick={() => setCreatedStaffCreds(null)}
             >
               + Create Another Staff Member
             </button>
             <button
               type="button"
               className="quiet"
               style={{ minHeight: '38px', padding: '0 14px' }}
               onClick={() => { setCreatedStaffCreds(null); setAdminDeviceTab('staff') }}
             >
               View All Staff Accounts
             </button>
           </div>
         </div>
       ) : (
         <form className="staff-create-form" onSubmit={handleCreateStaff}>
           <div className="staff-create-header">
             <h2>Create New Staff Account</h2>
             <p>Staff accounts receive Salesperson permissions. Staff can browse catalogue, take orders, and use offline mode.</p>
           </div>
           <label>
             Organization ID (Preset)
             <input type="text" value={session.organizationId} readOnly className="immutable-input" />
             <small className="field-hint">Staff will enter this Organization ID on the sign-in screen.</small>
           </label>
           <label>
             Staff Full / Display Name
             <input
               type="text"
               value={newStaffDisplayName}
               onChange={e => setNewStaffDisplayName(e.target.value)}
               placeholder="e.g. Rahul Sharma"
               autoComplete="off"
             />
           </label>
           <label>
             Staff Username <span style={{ color: 'var(--danger)' }}>*</span>
             <input
               type="text"
               value={newStaffUsername}
               onChange={e => setNewStaffUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''))}
               placeholder="e.g. rahul_sales"
               required
               autoComplete="off"
             />
             <small className="field-hint">Must be at least 3 characters. Alphanumeric, lowercase, underscores allowed.</small>
           </label>
           <label>
             Staff Password <span style={{ color: 'var(--danger)' }}>*</span>
             <div className="staff-password-wrapper">
               <input
                 type={showStaffPassword ? 'text' : 'password'}
                 value={newStaffPassword}
                 onChange={e => setNewStaffPassword(e.target.value)}
                 placeholder="Min 4 characters"
                 required
                 autoComplete="new-password"
               />
               <button
                 type="button"
                 className="staff-password-toggle"
                 onClick={() => setShowStaffPassword(p => !p)}
               >
                 {showStaffPassword ? 'Hide' : 'Show'}
               </button>
             </div>
             <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
               <button
                 type="button"
                 className="quiet"
                 style={{ minHeight: '28px', padding: '0 10px', fontSize: '12px' }}
                 onClick={() => {
                   const pwd = generateStaffPassword()
                   setNewStaffPassword(pwd)
                   setShowStaffPassword(true)
                 }}
               >
                 ⚡ Generate Strong Password
               </button>
             </div>
           </label>
           <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
             <button type="submit" className="primary" disabled={staffActionSubmitting} style={{ marginTop: 0 }}>
               {staffActionSubmitting ? 'Creating Staff Account…' : 'Create Staff Account'}
             </button>
             <button
               type="button"
               className="quiet"
               onClick={() => setAdminDeviceTab('staff')}
             >
               Cancel
             </button>
           </div>
         </form>
       )}
     </div>
   )}

   {adminDeviceTab === 'staff' && (
     <div>
       <div className="staff-action-bar">
         <input
           type="search"
           className="staff-search-input"
           placeholder="Search staff by name or @username…"
           value={staffSearchQuery}
           onChange={e => setStaffSearchQuery(e.target.value)}
         />
         <button
           type="button"
           className="quiet"
           style={{ fontWeight: 700 }}
           onClick={() => setAdminDeviceTab('add_staff')}
         >
           + Create New Staff Member
         </button>
       </div>

       <div className="admin-card-list">
         {(() => {
           const query = staffSearchQuery.trim().toLowerCase()
           const filteredStaff = staffList.filter(s =>
             !query ||
             s.username.toLowerCase().includes(query) ||
             s.display_name.toLowerCase().includes(query)
           )

           if (staffLoading) {
             return <p className="muted" style={{ padding: '24px 0' }}>Loading staff accounts…</p>
           }

           if (!filteredStaff.length) {
             return (
               <div style={{ textAlign: 'center', padding: '40px 16px' }}>
                 <p className="muted">
                   {query ? 'No staff members match your search.' : 'No staff accounts created yet.'}
                 </p>
                 {!query && (
                   <button
                     type="button"
                     className="primary"
                     style={{ maxWidth: '240px', margin: '16px auto 0' }}
                     onClick={() => setAdminDeviceTab('add_staff')}
                   >
                     + Create First Staff Account
                   </button>
                 )}
               </div>
             )
           }

           return filteredStaff.map(s => {
             const activeCount = Number(s.active_device_count || 0)
             const isStaffActive = s.is_active === 1
             return (
               <div className={`staff-card ${!isStaffActive ? 'suspended' : ''}`} key={s.id}>
                 <div className="staff-card-left">
                   <div className="staff-card-top">
                     <span className="staff-card-name">👤 {s.display_name || s.username}</span>
                     <span className="staff-card-username">@{s.username}</span>
                     <span className={`device-status-badge ${isStaffActive ? 'active' : 'revoked'}`}>
                       <i className="device-status-dot" /> {isStaffActive ? 'Active' : 'Suspended'}
                     </span>
                     <span style={{ fontSize: '11px', fontWeight: 700, color: activeCount > 0 ? 'var(--green)' : 'var(--muted)' }}>
                       {activeCount > 0 ? `🟢 ${activeCount} active device(s)` : '⚪ No active devices'}
                     </span>
                   </div>
                   <div className="staff-card-meta">
                     <span>Created: {new Date(s.created_at).toLocaleDateString()}</span>
                     <span>
                       Last active: {s.last_active_at ? new Date(s.last_active_at).toLocaleString() : 'Never logged in'}
                     </span>
                   </div>
                 </div>
                 <div className="staff-card-actions">
                   <button
                     type="button"
                     className="quiet"
                     style={{ fontSize: '12px', minHeight: '34px', padding: '0 10px' }}
                     onClick={() => {
                       setResetPasswordStaff(s)
                       setNewResetPasswordValue('')
                       setShowResetPasswordInput(false)
                     }}
                   >
                     🔑 Reset Password
                   </button>
                   <button
                     type="button"
                     className="quiet"
                     style={{
                       fontSize: '12px',
                       minHeight: '34px',
                       padding: '0 10px',
                       color: isStaffActive ? 'var(--danger)' : 'var(--green)'
                     }}
                     onClick={() => void handleToggleStaffActive(s.id)}
                   >
                     {isStaffActive ? '⏸️ Suspend' : '▶️ Activate'}
                   </button>
                   <button
                     type="button"
                     className="quiet"
                     style={{ fontSize: '12px', minHeight: '34px', padding: '0 8px', color: 'var(--muted)' }}
                     title="Permanently remove staff account"
                     onClick={() => void handleDeleteStaff(s)}
                   >
                     🗑️
                   </button>
                 </div>
               </div>
             )
           })
         })()}
       </div>
     </div>
   )}

   {(adminDeviceTab === 'active' || adminDeviceTab === 'all') && (
     <div className="admin-card-list">
       {(() => {
         const filteredDevices = adminDeviceTab === 'active'
           ? devices.filter(d => !d.revoked_at && new Date(d.offline_authorization_expires_at) > new Date())
           : devices

         if (!filteredDevices.length) {
           return (
             <p className="muted" style={{ padding: '24px 0' }}>
               {adminDeviceTab === 'active' ? 'No active device sessions found.' : 'No device sessions recorded yet.'}
             </p>
           )
         }

         return filteredDevices.map(d => {
           const lastSeenMs = Date.now() - new Date(d.last_seen_at).getTime()
           const isOnlineRecent = lastSeenMs < 24 * 60 * 60 * 1000
           const isIdleRecent = lastSeenMs < 7 * 24 * 60 * 60 * 1000
           const isExpired = new Date(d.offline_authorization_expires_at) <= new Date()

           let statusClass = 'inactive'
           let statusLabel = 'Inactive'

           if (d.revoked_at) {
             statusClass = 'revoked'
             statusLabel = 'Revoked'
           } else if (isExpired) {
             statusClass = 'revoked'
             statusLabel = 'Expired'
           } else if (isOnlineRecent) {
             statusClass = 'active'
             statusLabel = 'Active Recently'
           } else if (isIdleRecent) {
             statusClass = 'idle'
             statusLabel = 'Idle'
           }

           const accountDisplay = d.display_name || d.username || 'User'
           const usernameDisplay = d.username ? `@${d.username}` : ''
           const roleLabel = d.role === 'ADMIN' ? 'Admin' : 'Staff'

           return (
             <div className={`device-card ${d.revoked_at ? 'revoked' : ''}`} key={d.id}>
               <div className="device-card-left">
                 <div className="device-card-top">
                   <span className="device-card-name">📱 {d.device_name}</span>
                   <span className="device-card-user">
                     👤 {accountDisplay} {usernameDisplay && <small style={{ opacity: 0.8 }}>({usernameDisplay})</small>}
                     <span className="admin-badge" style={{ fontSize: '10px', padding: '1px 5px', marginLeft: '4px' }}>{roleLabel}</span>
                   </span>
                   <span className={`device-status-badge ${statusClass}`}>
                     <i className="device-status-dot" /> {statusLabel}
                   </span>
                 </div>
                 <div className="device-card-meta">
                   <span>Device ID: <code style={{ fontSize: '11px' }}>{d.device_id.slice(0, 13)}…</code></span>
                   <span>Last seen: {new Date(d.last_seen_at).toLocaleString()}</span>
                   <span>Expires: {new Date(d.offline_authorization_expires_at).toLocaleDateString()}</span>
                   {d.revoked_at && (
                     <span style={{ color: 'var(--danger)', fontWeight: 700 }}>
                       Revoked on {new Date(d.revoked_at).toLocaleString()}
                     </span>
                   )}
                 </div>
               </div>
               <div className="device-card-actions">
                 {!d.revoked_at && !isExpired && (
                   <button
                     type="button"
                     className="quiet"
                     style={{ color: 'var(--danger)', borderColor: 'var(--danger)', fontSize: '12px', minHeight: '34px' }}
                     onClick={() => void revokeDevice(d.id)}
                   >
                     Revoke access
                   </button>
                 )}
                 <button
                   type="button"
                   className="quiet"
                   style={{ color: 'var(--muted)', fontSize: '12px', minHeight: '34px', padding: '0 8px' }}
                   title="Remove session record from database"
                   onClick={() => void deleteDevice(d.id)}
                 >
                   🗑️ Remove
                 </button>
               </div>
             </div>
           )
         })
       })()}
     </div>
   )}

   {resetPasswordStaff && (
     <div className="product-modal-backdrop" onClick={() => setResetPasswordStaff(null)}>
       <div className="product-modal-card" style={{ maxWidth: '460px' }} onClick={e => e.stopPropagation()}>
         <div className="product-modal-header">
           <div>
             <h2>Reset Staff Password</h2>
             <p className="muted" style={{ margin: '4px 0 0', fontSize: '13px' }}>
               Set a new password for @{resetPasswordStaff.username} ({resetPasswordStaff.display_name}).
             </p>
           </div>
           <button className="close" onClick={() => setResetPasswordStaff(null)} style={{ position: 'static' }}>×</button>
         </div>
         <form onSubmit={handleResetStaffPassword} style={{ padding: '20px', display: 'grid', gap: '14px' }}>
           <label>
             New Password <span style={{ color: 'var(--danger)' }}>*</span>
             <div className="staff-password-wrapper">
               <input
                 type={showResetPasswordInput ? 'text' : 'password'}
                 value={newResetPasswordValue}
                 onChange={e => setNewResetPasswordValue(e.target.value)}
                 placeholder="Min 4 characters"
                 required
                 autoFocus
               />
               <button
                 type="button"
                 className="staff-password-toggle"
                 onClick={() => setShowResetPasswordInput(p => !p)}
               >
                 {showResetPasswordInput ? 'Hide' : 'Show'}
               </button>
             </div>
             <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
               <button
                 type="button"
                 className="quiet"
                 style={{ minHeight: '28px', padding: '0 10px', fontSize: '12px' }}
                 onClick={() => {
                   const pwd = generateStaffPassword()
                   setNewResetPasswordValue(pwd)
                   setShowResetPasswordInput(true)
                 }}
               >
                 ⚡ Generate Strong Password
               </button>
             </div>
           </label>
           <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '12px' }}>
             <button type="button" className="quiet" onClick={() => setResetPasswordStaff(null)}>
               Cancel
             </button>
             <button type="submit" className="primary" disabled={staffActionSubmitting} style={{ width: 'auto', marginTop: 0 }}>
               {staffActionSubmitting ? 'Updating…' : 'Update Password'}
             </button>
           </div>
         </form>
       </div>
     </div>
   )}
  </main>
 )}
  {detail && (
    <FullscreenViewer
      detail={detail}
      activeList={activeList}
      activeIndex={activeIndex}
      hasPrev={hasPrev}
      hasNext={hasNext}
      goPrev={goPrev}
      goNext={goNext}
      onClose={() => setDetail(null)}
      resolvedDetailUrl={resolvedDetailUrl}
      selected={selected}
      onToggle={toggle}
      onUpdateSelected={updateSelectedItem}
      categories={categories}
      subcategories={subcategories}
      grams={grams}
      orderCount={cart.length}
      onOpenOrderDrawer={() => setOrderDrawerOpen(true)}
    />
  )}
   {pdfModal && (() => {
    const isOrder = pdfModal.type === 'order' && Boolean(pdfModal.orderData)
    const isDemo = pdfModal.type === 'demo' && Boolean(pdfModal.demoPdf)

    const currentPdf = isOrder
      ? (pdfModal.orderData!.activeCopy === 'manufacturer' ? pdfModal.orderData!.manufacturer : pdfModal.orderData!.client)
      : pdfModal.demoPdf!

    return (
     <div className="pdf-preview-backdrop" role="dialog" aria-modal="true" aria-label="PDF Preview">
      <div className="pdf-preview-container">
       <div className="pdf-preview-toolbar">
        <div className="pdf-preview-toolbar-title">
         {isOrder && (
          <div className="pdf-copy-tabs" role="tablist" aria-label="Order PDF Copy Selector">
           <button
            type="button"
            className={`pdf-copy-tab ${pdfModal.orderData!.activeCopy === 'client' ? 'active' : ''}`}
            onClick={() => setPdfModal(prev => prev && prev.orderData ? {
             ...prev,
             orderData: { ...prev.orderData, activeCopy: 'client' }
            } : prev)}
           >
            📄 Client Copy (Full Details)
           </button>
           <button
            type="button"
            className={`pdf-copy-tab ${pdfModal.orderData!.activeCopy === 'manufacturer' ? 'active' : ''}`}
            onClick={() => setPdfModal(prev => prev && prev.orderData ? {
             ...prev,
             orderData: { ...prev.orderData, activeCopy: 'manufacturer' }
            } : prev)}
           >
            🏭 Manufacturer Copy (Vendor Redacted)
           </button>
          </div>
         )}
         {isDemo && (
          <strong style={{ color: '#ffd977', display: 'block', fontSize: '14px' }}>✨ High-Resolution Sales Demo Showcase</strong>
         )}
         <strong>{currentPdf.fileName}</strong>
         <span>
          {(currentPdf.blob.size / 1024).toFixed(1)} KB &middot; {isOrder ? (pdfModal.orderData!.activeCopy === 'manufacturer' ? 'Manufacturer Copy (Vendor details redacted)' : 'Official Client Order Sheet') : `${currentPdf.totalQuantity} Showcase Page(s)`} &middot; {currentPdf.totalQuantity} {isDemo ? 'designs' : 'pcs'}, {grams(currentPdf.totalWeightMg)} g
         </span>
        </div>
        <div className="pdf-preview-actions">
         <button
          type="button"
          className="primary"
          onClick={() => downloadPdfBlob(currentPdf.blob, currentPdf.fileName)}
         >
          📥 Download PDF
         </button>
         <button
          type="button"
          className="quiet"
          onClick={async () => {
           const shared = await sharePdfFile(
            currentPdf.blob,
            currentPdf.fileName,
            currentPdf.order,
            currentPdf.fileName,
            isDemo ? `Shine Jewels High-Resolution Sales Demo Showcase (${currentPdf.totalQuantity} designs)` : undefined
           );
           if (shared) {
            setNotice('PDF shared successfully.');
           } else {
            downloadPdfBlob(currentPdf.blob, currentPdf.fileName);
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
           if (pdfModal.orderData) {
            URL.revokeObjectURL(pdfModal.orderData.client.blobUrl);
            URL.revokeObjectURL(pdfModal.orderData.manufacturer.blobUrl);
           }
           if (pdfModal.demoPdf) {
            URL.revokeObjectURL(pdfModal.demoPdf.blobUrl);
           }
           setPdfModal(null);
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
         src={currentPdf.blobUrl}
         title="PDF Preview"
        />
       </div>
      </div>
     </div>
    )
   })()}
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
    <DeleteConfirmModal
     product={archivingProduct}
     onConfirm={() => handleConfirmArchive(archivingProduct)}
     onClose={() => setArchivingProduct(null)}
    />
   )}
  <footer>Built by Aadit Mehta, contact mail: <a href="mailto:aaditbusiness15@gmail.com">aaditbusiness15@gmail.com</a>, mobile: <a href="tel:7304767688">7304767688</a></footer></div>
</>
}
