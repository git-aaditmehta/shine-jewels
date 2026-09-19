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

export function Taxonomy({categories,subcategories,onCategory,onSubcategory,notice}:Pick<Props,'categories'|'subcategories'|'onCategory'|'onSubcategory'|'notice'>){
  const addCategory=async(e:React.FormEvent<HTMLFormElement>)=>{
    e.preventDefault()
    const form=e.currentTarget
    const name=String(new FormData(form).get('name')||'').trim()
    if(!name)return
    if(categories.some(x=>x.name.toLowerCase()===name.toLowerCase())){
      notice('That category already exists.')
      return
    }
    form.reset()
    await onCategory({id:uid(),name,active:true})
    notice('Category added locally.')
  }
  const addSub=async(e:React.FormEvent<HTMLFormElement>)=>{
    e.preventDefault()
    const form=e.currentTarget
    const f=new FormData(form),categoryId=String(f.get('category')||''),name=String(f.get('name')||'').trim()
    if(!categoryId||!name)return
    if(subcategories.some(x=>x.categoryId===categoryId&&x.name.toLowerCase()===name.toLowerCase())){
      notice('That subcategory already exists in the selected category.')
      return
    }
    form.reset()
    await onSubcategory({id:uid(),categoryId,name,active:true})
    notice('Subcategory added locally.')
  }
  return (
    <section className="taxonomy">
      <div>
        <p className="eyebrow">classification</p>
        <h1>Categories shape the catalogue.</h1>
        <form onSubmit={e=>void addCategory(e)}>
          <h2>Add category</h2>
          <label>Name<input name="name" required/></label>
          <button className="primary">Add category</button>
        </form>
        <form onSubmit={e=>void addSub(e)}>
          <h2>Add subcategory</h2>
          <label>Category
            <select name="category" required>
              <option value="">Choose category</option>
              {categories.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>Name<input name="name" required/></label>
          <button className="primary">Add subcategory</button>
        </form>
      </div>
      <div className="taxonomy-list">
        {categories.map(c=><article key={c.id}><strong>{c.name}</strong>{subcategories.filter(s=>s.categoryId===c.id).map(s=><span key={s.id}>{s.name}</span>)}</article>)}
      </div>
    </section>
  )
}
