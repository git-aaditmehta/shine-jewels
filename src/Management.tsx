import { useEffect, useState } from 'react'
import type { Category, Product, Subcategory } from './types'

const uid=()=>crypto.randomUUID()
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB limit

export async function processDualImages(file: File): Promise<{ gridImage: string; detailImage: string }> {
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(`Image size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds the 5 MB limit.`)
  }
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Failed to decode image file.'))
      el.src = objectUrl
    })
    const { naturalWidth: width, naturalHeight: height } = img

    const renderToDataUrl = (maxDim: number, quality: number): string => {
      let targetW = width
      let targetH = height
      if (targetW > maxDim || targetH > maxDim) {
        if (targetW >= targetH) {
          targetH = Math.round((targetH * maxDim) / targetW)
          targetW = maxDim
        } else {
          targetW = Math.round((targetW * maxDim) / targetH)
          targetH = maxDim
        }
      }
      const canvas = document.createElement('canvas')
      canvas.width = targetW
      canvas.height = targetH
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas rendering context unavailable.')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, targetW, targetH)
      return canvas.toDataURL('image/jpeg', quality)
    }

    // Detail: up to 2400px at 0.92 quality (retains full brilliance, facets, and gold reflection)
    const detailImage = renderToDataUrl(2400, 0.92)
    // Grid: up to 600px at 0.85 quality (sharp retina thumbnail, memory safe)
    const gridImage = renderToDataUrl(600, 0.85)

    return { gridImage, detailImage }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

const validWeight=(s:string)=>/^\d+(\.\d{1,3})?$/.test(s)&&Number(s)>0
type Props={categories:Category[];subcategories:Subcategory[];onProduct:(p:Product)=>Promise<void>;onCategory:(c:Category)=>Promise<void>;onSubcategory:(s:Subcategory)=>Promise<void>;notice:(s:string)=>void}

export function ProductEntry({categories,subcategories,onProduct}:Pick<Props,'categories'|'subcategories'|'onProduct'>){
  const [categoryId,setCategory]=useState(''),[sub,setSub]=useState(''),[error,setError]=useState('')
  const [previewFile,setPreviewFile]=useState<File|null>(null)
  const [previewUrl,setPreviewUrl]=useState<string|null>(null)

  useEffect(()=>{
    if(!previewFile){setPreviewUrl(null);return}
    const url=URL.createObjectURL(previewFile)
    setPreviewUrl(url)
    return ()=>URL.revokeObjectURL(url)
  },[previewFile])

  const handleFileChange=(e:React.ChangeEvent<HTMLInputElement>)=>{
    const file=e.target.files?.[0]
    if(!file){setPreviewFile(null);return}
    if(file.size>MAX_IMAGE_SIZE_BYTES){
      setError(`Image size (${(file.size/(1024*1024)).toFixed(1)} MB) exceeds 5 MB limit. Please choose an image under 5 MB.`)
      e.target.value=''
      setPreviewFile(null)
      return
    }
    setError('')
    setPreviewFile(file)
  }

  const submit=async(e:React.FormEvent<HTMLFormElement>)=>{
    e.preventDefault()
    const form=e.currentTarget
    const f=new FormData(form),weight=String(f.get('weight')||''),code=String(f.get('code')||'').trim().toUpperCase()
    const file=previewFile||(f.get('image') as File)
    if(!categoryId||!sub||!code||!validWeight(weight)||!file?.size){
      setError('Choose a category and subcategory, enter a valid design code and weight (up to 0.001 g), then select an image.')
      return
    }
    try{
      const {gridImage,detailImage}=await processDualImages(file)
      const prod={id:uid(),designCode:code,categoryId,subcategoryId:sub,weightMg:Math.round(Number(weight)*1000),gridImage,detailImage,imageVersion:1,syncState:'PENDING_UPLOAD' as const}
      form.reset()
      setCategory('')
      setSub('')
      setError('')
      setPreviewFile(null)
      await onProduct(prod)
    }catch(err){
      setError(err instanceof Error?err.message:'Image processing failed.')
    }
  }

  return (
    <form className="entry-form" onSubmit={e=>void submit(e)}>
      <h2>Add one design</h2>
      {error&&<p className="field-error" role="alert">{error}</p>}
      <label>Design code<input name="code" required pattern="[A-Za-z0-9-]+" /></label>
      <label>Category
        <select value={categoryId} onChange={e=>{setCategory(e.target.value);setSub('')}} required>
          <option value="">Choose category</option>
          {categories.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label>Subcategory
        <select value={sub} onChange={e=>setSub(e.target.value)} required disabled={!categoryId}>
          <option value="">Choose subcategory</option>
          {subcategories.filter(x=>x.categoryId===categoryId).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label>Weight in grams<input name="weight" inputMode="decimal" placeholder="12.345" required /></label>
      <label>Image (Max 5 MB)
        <input name="image" type="file" accept="image/*" onChange={handleFileChange} required={!previewFile} />
      </label>
      {previewUrl&&previewFile&&(
        <div className="upload-preview">
          <img src={previewUrl} alt="Selected jewelry design preview" />
          <div>
            <strong>{previewFile.name}</strong>
            <span>{(previewFile.size/(1024*1024)).toFixed(2)} MB · Ready to stage</span>
          </div>
          <button type="button" className="quiet" onClick={()=>setPreviewFile(null)}>Clear</button>
        </div>
      )}
      <button className="primary">Stage design</button>
    </form>
  )
}

export function BatchEntry({categories,subcategories,onProduct}:Pick<Props,'categories'|'subcategories'|'onProduct'>){
  const [queue,setQueue]=useState<File[]>([])
  const [categoryId,setCategory]=useState('')
  const [sub,setSub]=useState('')
  const [code,setCode]=useState('')
  const [weight,setWeight]=useState('')
  const [error,setError]=useState('')
  const [activePreview,setActivePreview]=useState<string|null>(null)

  const activeFile=queue[0]

  useEffect(()=>{
    if(!activeFile){setActivePreview(null);return}
    const url=URL.createObjectURL(activeFile)
    setActivePreview(url)
    return ()=>URL.revokeObjectURL(url)
  },[activeFile])

  const handleFiles=(e:React.ChangeEvent<HTMLInputElement>)=>{
    const incoming=Array.from(e.target.files||[])
    const valid:File[]=[]
    let skipped=0
    for(const f of incoming){
      if(f.size<=MAX_IMAGE_SIZE_BYTES){
        valid.push(f)
      }else{
        skipped++
      }
    }
    if(skipped>0){
      setError(`${skipped} image(s) skipped because they exceeded the 5 MB limit.`)
    }else{
      setError('')
    }
    setQueue(q=>[...q,...valid])
    e.target.value=''
  }

  const save=async()=>{
    const file=queue[0]
    if(!file||!categoryId||!sub||!code.trim()||!validWeight(weight)){
      setError('Complete the fixed category, subcategory, design code and weight for the active image.')
      return
    }
    try{
      const {gridImage,detailImage}=await processDualImages(file)
      const designCode=code.trim().toUpperCase()
      const prod={id:uid(),designCode,categoryId,subcategoryId:sub,weightMg:Math.round(Number(weight)*1000),gridImage,detailImage,imageVersion:1,syncState:'PENDING_UPLOAD' as const}
      setQueue(q=>q.slice(1))
      setCode('')
      setWeight('')
      setError('')
      await onProduct(prod)
    }catch(err){
      setError(err instanceof Error?err.message:'Batch image processing failed.')
    }
  }

  return (
    <section className="batch">
      <div>
        <p className="eyebrow">queued image workflow</p>
        <h2>Batch design entry</h2>
        <p className="muted">The selected category and subcategory apply to the queue. Uploaded images are compressed without quality loss (max 5 MB per file).</p>
      </div>
      <div className="batch-layout">
        <label className="drop">
          Load images (Max 5 MB each)
          <input type="file" accept="image/*" multiple onChange={handleFiles} />
          <strong>{queue.length} images queued</strong>
        </label>
        <div className="batch-form">
          {error&&<p className="field-error" role="alert">{error}</p>}
          {activePreview&&activeFile&&(
            <div className="batch-active-preview">
              <img src={activePreview} alt="Active design to stage" />
              <div>
                <span className="eyebrow">Active image</span>
                <strong>{activeFile.name}</strong>
                <small>{(activeFile.size/(1024*1024)).toFixed(2)} MB</small>
              </div>
            </div>
          )}
          <label>Category
            <select value={categoryId} onChange={e=>{setCategory(e.target.value);setSub('')}}>
              <option value="">Choose category</option>
              {categories.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>Subcategory
            <select value={sub} disabled={!categoryId} onChange={e=>setSub(e.target.value)}>
              <option value="">Choose subcategory</option>
              {subcategories.filter(x=>x.categoryId===categoryId).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>Active design code
            <input value={code} onChange={e=>setCode(e.target.value)} disabled={!queue.length} placeholder="e.g. SJ-2001" />
          </label>
          <label>Weight in grams
            <input value={weight} onChange={e=>setWeight(e.target.value)} disabled={!queue.length} placeholder="14.250" inputMode="decimal" />
          </label>
          <button className="primary" disabled={!queue.length} onClick={()=>void save()}>Save active &amp; next</button>
        </div>
      </div>
      <div className="queue">
        {queue.map((f,i)=>(
          <div className={i===0?'active':''} key={`${f.name}${i}`}>
            <span>{i===0?'Active':'Queued'}</span>
            {f.name} ({(f.size/(1024*1024)).toFixed(2)} MB)
            <button className="quiet" onClick={()=>setQueue(q=>q.filter((_,index)=>index!==i))}>Remove</button>
          </div>
        ))}
      </div>
    </section>
  )
}

import {
  EditCategoryModal,
  ArchiveCategoryModal,
  EditSubcategoryModal,
  ArchiveSubcategoryModal
} from './TaxonomyModals'

export interface TaxonomyProps {
  categories: Category[]
  subcategories: Subcategory[]
  archivedCategoriesList: Category[]
  archivedSubcategoriesList: Subcategory[]
  products: Product[]
  onCategory: (c: Category) => Promise<void>
  onSubcategory: (s: Subcategory) => Promise<void>
  onUpdateCategory: (c: Category) => Promise<void>
  onUpdateSubcategory: (s: Subcategory) => Promise<void>
  onArchiveCategory: (id: string) => Promise<void>
  onRestoreCategory: (id: string) => Promise<void>
  onArchiveSubcategory: (id: string) => Promise<void>
  onRestoreSubcategory: (id: string) => Promise<void>
  notice: (s: string) => void
}

export function Taxonomy({
  categories,
  subcategories,
  archivedCategoriesList,
  archivedSubcategoriesList,
  products,
  onCategory,
  onSubcategory,
  onUpdateCategory,
  onUpdateSubcategory,
  onArchiveCategory,
  onRestoreCategory,
  onArchiveSubcategory,
  onRestoreSubcategory,
  notice
}: TaxonomyProps) {
  const [tab, setTab] = useState<'view' | 'add' | 'archived'>('view')
  const [search, setSearch] = useState('')

  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [archivingCategoryState, setArchivingCategoryState] = useState<{ category: Category; productCount: number } | null>(null)

  const [editingSubcategory, setEditingSubcategory] = useState<Subcategory | null>(null)
  const [archivingSubcategoryState, setArchivingSubcategoryState] = useState<{ subcategory: Subcategory; productCount: number } | null>(null)

  const activeProducts = products.filter(p => !p.deleted)

  const handleStartArchiveCategory = (cat: Category) => {
    const referencing = activeProducts.filter(p => p.categoryId === cat.id).length
    setArchivingCategoryState({ category: cat, productCount: referencing })
  }

  const handleStartArchiveSubcategory = (sub: Subcategory) => {
    const referencing = activeProducts.filter(p => p.subcategoryId === sub.id).length
    setArchivingSubcategoryState({ subcategory: sub, productCount: referencing })
  }

  const addCategory = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const name = String(new FormData(form).get('name') || '').trim()
    if (!name) return
    if (categories.some(x => x.name.toLowerCase() === name.toLowerCase())) {
      notice('That category already exists.')
      return
    }
    form.reset()
    await onCategory({ id: uid(), name, active: true })
    notice(`Category "${name}" added successfully.`)
  }

  const addSub = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    const categoryId = String(f.get('category') || '')
    const name = String(f.get('name') || '').trim()
    if (!categoryId || !name) return
    if (subcategories.some(x => x.categoryId === categoryId && x.name.toLowerCase() === name.toLowerCase())) {
      notice('That subcategory already exists in the selected category.')
      return
    }
    form.reset()
    await onSubcategory({ id: uid(), categoryId, name, active: true })
    notice(`Subcategory "${name}" added successfully.`)
  }

  const filteredCategories = categories.filter(c => {
    if (!search.trim()) return true
    const term = search.toLowerCase().trim()
    const matchCat = c.name.toLowerCase().includes(term)
    const matchSubs = subcategories.some(s => s.categoryId === c.id && s.name.toLowerCase().includes(term))
    return matchCat || matchSubs
  })

  return (
    <section className="taxonomy-admin-section">
      <div className="section-title">
        <div>
          <p className="eyebrow">taxonomy administration</p>
          <h1>Categories &amp; Subcategories</h1>
        </div>
        <span>{categories.length} categories · {subcategories.length} subcategories</span>
      </div>

      <div className="catalogue-admin-tabs">
        <button
          type="button"
          className={`catalogue-admin-tab ${tab === 'view' ? 'active' : ''}`}
          onClick={() => setTab('view')}
        >
          Active Taxonomy <span className="admin-badge">{categories.length}</span>
        </button>
        <button
          type="button"
          className={`catalogue-admin-tab ${tab === 'add' ? 'active' : ''}`}
          onClick={() => setTab('add')}
        >
          + Add Category / Subcategory
        </button>
        <button
          type="button"
          className={`catalogue-admin-tab ${tab === 'archived' ? 'active' : ''}`}
          onClick={() => setTab('archived')}
        >
          Archived Taxonomy <span className="admin-badge">{archivedCategoriesList.length + archivedSubcategoriesList.length}</span>
        </button>
      </div>

      {tab === 'view' && (
        <div>
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <input
              type="search"
              placeholder="Filter categories and subcategories..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ maxWidth: '360px' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {filteredCategories.length === 0 ? (
              <p className="muted" style={{ padding: '20px 0' }}>No matching categories found.</p>
            ) : (
              filteredCategories.map(c => {
                const subs = subcategories.filter(s => s.categoryId === c.id)
                const productCount = activeProducts.filter(p => p.categoryId === c.id).length
                return (
                  <article key={c.id} className="admin-taxonomy-card">
                    <div className="admin-taxonomy-header">
                      <div className="admin-taxonomy-title">
                        <strong>{c.name}</strong>
                        <span className="admin-badge" style={{ background: 'var(--sheet)', color: 'var(--ink)' }}>
                          {productCount} active design{productCount === 1 ? '' : 's'}
                        </span>
                        <span className="admin-badge" style={{ background: 'var(--gold-soft)', color: 'var(--gold-deep)' }}>
                          {subs.length} subcategor{subs.length === 1 ? 'y' : 'ies'}
                        </span>
                      </div>
                      <div className="admin-taxonomy-actions">
                        <button
                          type="button"
                          className="quiet"
                          style={{ minHeight: '32px', padding: '0 10px', fontSize: '12px' }}
                          onClick={() => setEditingCategory(c)}
                        >
                          ✏️ Rename
                        </button>
                        <button
                          type="button"
                          className="quiet"
                          style={{ minHeight: '32px', padding: '0 10px', fontSize: '12px', color: 'var(--danger)', borderColor: 'var(--danger)' }}
                          onClick={() => handleStartArchiveCategory(c)}
                        >
                          🗑️ Archive
                        </button>
                      </div>
                    </div>

                    <div className="admin-taxonomy-sub-list">
                      {subs.length === 0 ? (
                        <span className="muted" style={{ fontSize: '12px', fontStyle: 'italic' }}>No subcategories assigned yet.</span>
                      ) : (
                        subs.map(s => {
                          const subProductCount = activeProducts.filter(p => p.subcategoryId === s.id).length
                          return (
                            <div key={s.id} className="admin-taxonomy-sub-pill">
                              <span className="admin-taxonomy-sub-name">{s.name}</span>
                              <small style={{ color: 'var(--muted)', fontSize: '11px' }}>({subProductCount} designs)</small>
                              <div className="admin-taxonomy-sub-buttons">
                                <button
                                  type="button"
                                  className="quiet"
                                  style={{ minHeight: '24px', padding: '0 6px', fontSize: '11px', border: 'none' }}
                                  onClick={() => setEditingSubcategory(s)}
                                  title="Rename subcategory"
                                >
                                  ✏️
                                </button>
                                <button
                                  type="button"
                                  className="quiet"
                                  style={{ minHeight: '24px', padding: '0 6px', fontSize: '11px', border: 'none', color: 'var(--danger)' }}
                                  onClick={() => handleStartArchiveSubcategory(s)}
                                  title="Archive subcategory"
                                >
                                  🗑️
                                </button>
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </article>
                )
              })
            )}
          </div>
        </div>
      )}

      {tab === 'add' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-4)' }}>
          <form className="entry-form" onSubmit={e => void addCategory(e)}>
            <h2>Add Category</h2>
            <p className="muted" style={{ fontSize: '13px', margin: '0 0 var(--space-3)' }}>
              Top-level classification for jewelry (e.g. Rings, Necklaces, Bangles).
            </p>
            <label>
              Category Name
              <input name="name" placeholder="e.g. Bangles" required />
            </label>
            <button className="primary" style={{ marginTop: 'var(--space-2)' }}>Add Category</button>
          </form>

          <form className="entry-form" onSubmit={e => void addSub(e)}>
            <h2>Add Subcategory</h2>
            <p className="muted" style={{ fontSize: '13px', margin: '0 0 var(--space-3)' }}>
              Specific style or variation within an existing category (e.g. Solitaire, Choker).
            </p>
            <label>
              Parent Category
              <select name="category" required defaultValue="">
                <option value="" disabled>Choose parent category</option>
                {categories.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>
              Subcategory Name
              <input name="name" placeholder="e.g. Solitaire" required />
            </label>
            <button className="primary" style={{ marginTop: 'var(--space-2)' }}>Add Subcategory</button>
          </form>
        </div>
      )}

      {tab === 'archived' && (
        <div>
          <div style={{ padding: '12px 16px', background: 'var(--gold-soft)', borderRadius: '10px', marginBottom: 'var(--space-4)', fontSize: '13px', color: 'var(--ink)' }}>
            ℹ️ Archived categories and subcategories are excluded from catalogue filter dropdowns and new design entry forms. Restoring them reactivates them immediately.
          </div>

          <h3 style={{ fontSize: '16px', margin: 'var(--space-4) 0 var(--space-2)' }}>
            Archived Categories ({archivedCategoriesList.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
            {archivedCategoriesList.length === 0 ? (
              <p className="muted" style={{ fontSize: '13px' }}>No archived categories.</p>
            ) : (
              archivedCategoriesList.map(c => (
                <div key={c.id} className="admin-product-row" style={{ padding: '12px 16px' }}>
                  <div>
                    <strong style={{ fontSize: '15px' }}>{c.name}</strong>
                    <span style={{ fontSize: '12px', color: 'var(--danger)', display: 'block', marginTop: '2px' }}>Archived Category</span>
                  </div>
                  <button
                    type="button"
                    className="quiet"
                    style={{ minHeight: '32px', padding: '0 12px', fontSize: '12px', fontWeight: 700, color: 'var(--green)', borderColor: 'var(--green)' }}
                    onClick={() => void onRestoreCategory(c.id)}
                  >
                    🔄 Restore Category
                  </button>
                </div>
              ))
            )}
          </div>

          <h3 style={{ fontSize: '16px', margin: 'var(--space-4) 0 var(--space-2)' }}>
            Archived Subcategories ({archivedSubcategoriesList.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {archivedSubcategoriesList.length === 0 ? (
              <p className="muted" style={{ fontSize: '13px' }}>No archived subcategories.</p>
            ) : (
              archivedSubcategoriesList.map(s => {
                const parentCat = categories.find(c => c.id === s.categoryId)?.name ||
                  archivedCategoriesList.find(c => c.id === s.categoryId)?.name || 'Unknown Category'
                return (
                  <div key={s.id} className="admin-product-row" style={{ padding: '12px 16px' }}>
                    <div>
                      <strong style={{ fontSize: '15px' }}>{s.name}</strong>
                      <span style={{ fontSize: '12px', color: 'var(--muted)', display: 'block', marginTop: '2px' }}>
                        Category: {parentCat}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="quiet"
                      style={{ minHeight: '32px', padding: '0 12px', fontSize: '12px', fontWeight: 700, color: 'var(--green)', borderColor: 'var(--green)' }}
                      onClick={() => void onRestoreSubcategory(s.id)}
                    >
                      🔄 Restore Subcategory
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      {editingCategory && (
        <EditCategoryModal
          category={editingCategory}
          existingCategories={categories}
          onSave={onUpdateCategory}
          onClose={() => setEditingCategory(null)}
        />
      )}

      {archivingCategoryState && (
        <ArchiveCategoryModal
          category={archivingCategoryState.category}
          productCount={archivingCategoryState.productCount}
          onConfirm={async () => {
            await onArchiveCategory(archivingCategoryState.category.id)
            setArchivingCategoryState(null)
          }}
          onClose={() => setArchivingCategoryState(null)}
        />
      )}

      {editingSubcategory && (
        <EditSubcategoryModal
          subcategory={editingSubcategory}
          existingSubcategories={subcategories}
          onSave={onUpdateSubcategory}
          onClose={() => setEditingSubcategory(null)}
        />
      )}

      {archivingSubcategoryState && (
        <ArchiveSubcategoryModal
          subcategory={archivingSubcategoryState.subcategory}
          productCount={archivingSubcategoryState.productCount}
          onConfirm={async () => {
            await onArchiveSubcategory(archivingSubcategoryState.subcategory.id)
            setArchivingSubcategoryState(null)
          }}
          onClose={() => setArchivingSubcategoryState(null)}
        />
      )}
    </section>
  )
}

