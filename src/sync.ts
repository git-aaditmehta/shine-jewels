
import { workerApi } from './api'
import { storage } from './storage'
import type { Category, Order, Product, Subcategory, Vendor } from './types'

type Change = { sequence_number: number; entity_type: string; entity_id: string; operation: string; payload: string }
type Bootstrap = { categories: Record<string, unknown>[]; subcategories: Record<string, unknown>[]; vendors: Record<string, unknown>[]; products: Record<string, unknown>[]; presentations: Record<string, unknown>[]; checkpoint: number }

const r2 = import.meta.env.VITE_R2_PUBLIC_BASE_URL?.replace(/\/$/, '') || 'https://pub-ddd4389cc31a46b6b365e21911f96e1f.r2.dev'
const imageUrl = (key: unknown) => `${r2}/${String(key).split('/').map(encodeURIComponent).join('/')}`

export const productFromRecord = (x: Record<string, unknown>): Product => {
  const gridObj = typeof x.gridImage === 'object' && x.gridImage !== null ? (x.gridImage as Record<string, unknown>) : null
  const detailObj = typeof x.detailImage === 'object' && x.detailImage !== null ? (x.detailImage as Record<string, unknown>) : null

  let gridKey = String(x.grid_image_key || gridObj?.key || x.gridImageKey || '')
  let detailKey = String(x.detail_image_key || detailObj?.key || x.detailImageKey || '')

  let gridChecksum = String(x.grid_image_checksum || gridObj?.checksum || x.gridImageChecksum || '')
  let detailChecksum = String(x.detail_image_checksum || detailObj?.checksum || x.detailImageChecksum || '')

  let gridSize = Number(x.grid_image_size_bytes || gridObj?.sizeBytes || x.gridImageSizeBytes || 0)
  let detailSize = Number(x.detail_image_size_bytes || detailObj?.sizeBytes || x.detailImageSizeBytes || 0)

  // Heal corrupt detail image metadata (< 1000 byte HTML documents from legacy bug)
  if (detailSize > 0 && detailSize < 1000 && gridSize >= 1000) {
    detailKey = gridKey
    detailChecksum = gridChecksum
    detailSize = gridSize
  }

  let gridImg = ''
  if (gridKey) {
    gridImg = imageUrl(gridKey)
  } else if (typeof x.gridImage === 'string' && x.gridImage) {
    gridImg = x.gridImage
  }

  let detailImg = ''
  if (detailKey) {
    detailImg = imageUrl(detailKey)
  } else if (typeof x.detailImage === 'string' && x.detailImage) {
    detailImg = x.detailImage
  }
  if (!detailImg || (typeof detailImg === 'string' && !detailImg.startsWith('data:') && !detailImg.startsWith('http'))) {
    detailImg = gridImg
  }

  return {
    id: String(x.id),
    designCode: String(x.design_code || x.designCode || ''),
    categoryId: String(x.category_id || x.categoryId || ''),
    subcategoryId: String(x.subcategory_id || x.subcategoryId || ''),
    weightMg: Number(x.weight_mg || x.weightMg || 0),
    gridImage: gridImg,
    detailImage: detailImg,
    imageVersion: Number(x.image_version || x.imageVersion || 1),
    syncState: 'SYNCED' as const,
    deleted: Boolean(x.deleted_at || x.deleted),
    gridImageKey: gridKey || undefined,
    detailImageKey: detailKey || undefined,
    gridImageChecksum: gridChecksum || undefined,
    detailImageChecksum: detailChecksum || undefined,
    gridImageSizeBytes: gridSize || undefined,
    detailImageSizeBytes: detailSize || undefined
  }
}

const category = (x: Record<string, unknown>) => ({ id: String(x.id), name: String(x.name), active: !x.deleted_at && Boolean(x.is_active ?? true) })
const subcategory = (x: Record<string, unknown>) => ({ id: String(x.id), categoryId: String(x.category_id || x.categoryId), name: String(x.name), active: !x.deleted_at && Boolean(x.is_active ?? true) })
const vendor = (x: Record<string, unknown>) => ({ id: String(x.id), name: String(x.name), address: String(x.address), city: String(x.city), type: String(x.type) as any, deleted: Boolean(x.deleted_at || x.deleted) })
const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

export async function computeSha256(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? await (await fetch(data)).arrayBuffer() : data
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function sourceToBlobAndChecksum(source: string): Promise<{ blob: Blob; checksum: string; contentType: string }> {
  if (!source) throw new Error('Image source is empty.')
  if (source.startsWith('data:')) {
    const parts = source.split(',')
    const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg'
    const binary = atob(parts[1] || '')
    const len = binary.length
    const u8arr = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      u8arr[i] = binary.charCodeAt(i)
    }
    const checksum = await computeSha256(u8arr.buffer)
    const blob = new Blob([u8arr], { type: mime })
    return { blob, checksum, contentType: mime }
  }
  if (!source.startsWith('http://') && !source.startsWith('https://')) {
    const localData = await storage.getImage(source)
    if (localData && localData.startsWith('data:')) {
      return sourceToBlobAndChecksum(localData)
    }
    throw new Error(`Cannot load image from non-URL source: ${source}`)
  }
  const res = await fetch(source)
  if (!res.ok) throw new Error(`Could not load image resource (${res.status}).`)
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/html')) {
    throw new Error('Received HTML document instead of image.')
  }
  const blob = await res.blob()
  if (blob.size < 500 && contentType.includes('html')) {
    throw new Error('Received invalid HTML response for image.')
  }
  const buffer = await blob.arrayBuffer()
  const checksum = await computeSha256(buffer)
  return { blob, checksum, contentType: blob.type || contentType || 'image/jpeg' }
}

async function directUpload(token: string, productId: string, representation: 'grid' | 'detail', source: string, version: number, precomputed?: { blob: Blob; checksum: string; contentType: string }) {
  const { blob, checksum, contentType } = precomputed || await sourceToBlobAndChecksum(source)
  const grant = await workerApi<{ key: string; headers: Record<string, string>; url: string; sizeBytes: number; checksum: string }>('/images/upload-authorizations', {
    method: 'POST',
    token,
    body: { productId, representation, imageVersion: version, sizeBytes: blob.size, checksum, contentType }
  })
  const response = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: blob })
  if (!response.ok) throw new Error(`Direct ${representation} upload failed with status ${response.status}.`)
  await workerApi('/images/confirm', { method: 'POST', token, body: { key: grant.key, sizeBytes: grant.sizeBytes, checksum: grant.checksum } })
  return { key: grant.key, sizeBytes: grant.sizeBytes, checksum: grant.checksum }
}

export async function uploadProductOnline(token: string, productId: string): Promise<Product & { id: string }> {
  const initialItem = (await storage.products()).find(x => x.id === productId)
  if (!initialItem) throw new Error('Product not found locally.')
  const categories = await storage.categories(), subcategories = await storage.subcategories()
  const localCategory = categories.find(x => x.id === initialItem.categoryId)
  const localSubcategory = subcategories.find(x => x.id === initialItem.subcategoryId)
  if (!localCategory || !localSubcategory) throw new Error('Product category or subcategory is missing locally.')

  const bootstrap = await workerApi<Bootstrap>('/sync/bootstrap', { token })
  let remoteCategory = bootstrap.categories.find(x => !x.deleted_at && same(String(x.name), localCategory.name))
  if (!remoteCategory) remoteCategory = await workerApi<Record<string, unknown>>('/categories', { method: 'POST', token, body: { id: localCategory.id, name: localCategory.name } })
  await storage.remapCategoryId(localCategory.id, String(remoteCategory.id))

  const remappedItem = (await storage.products()).find(x => x.id === productId)
  if (!remappedItem) throw new Error('Product lost during category remap.')
  const targetCategoryId = remappedItem.categoryId
  let remoteSubcategory = bootstrap.subcategories.find(x => !x.deleted_at && String(x.category_id) === targetCategoryId && same(String(x.name), localSubcategory.name))
  if (!remoteSubcategory) remoteSubcategory = await workerApi<Record<string, unknown>>('/subcategories', { method: 'POST', token, body: { id: localSubcategory.id, name: localSubcategory.name, categoryId: targetCategoryId } })
  await storage.remapSubcategoryId(localSubcategory.id, String(remoteSubcategory.id))

  const finalItem = (await storage.products()).find(x => x.id === productId) || (await storage.archivedProducts()).find(x => x.id === productId)
  if (!finalItem) throw new Error('Product lost during subcategory remap.')

  let gridImage = { key: finalItem.gridImageKey || '', sizeBytes: finalItem.gridImageSizeBytes || 0, checksum: finalItem.gridImageChecksum || '' }
  let detailImage = { key: finalItem.detailImageKey || '', sizeBytes: finalItem.detailImageSizeBytes || 0, checksum: finalItem.detailImageChecksum || '' }

  // Resolve actual image data if local OPFS path
  let gridSource = finalItem.gridImage
  if (!gridSource.startsWith('data:') && !gridSource.startsWith('http://') && !gridSource.startsWith('https://')) {
    gridSource = (await storage.getImage(gridSource)) || ''
  }
  let detailSource = finalItem.detailImage
  if (!detailSource.startsWith('data:') && !detailSource.startsWith('http://') && !detailSource.startsWith('https://')) {
    detailSource = (await storage.getImage(detailSource)) || ''
  }
  // If detail image could not be resolved, fall back to gridSource
  if (!detailSource) {
    detailSource = gridSource
  }
  if (!gridSource) {
    gridSource = detailSource
  }

  const needsGridUpload = gridSource.startsWith('data:') || !finalItem.gridImageKey
  const needsDetailUpload = detailSource.startsWith('data:') || !finalItem.detailImageKey || (finalItem.detailImageSizeBytes !== undefined && finalItem.detailImageSizeBytes < 1000)

  if (needsGridUpload || needsDetailUpload) {
    let gridPre: { blob: Blob; checksum: string; contentType: string } | undefined
    let detailPre: { blob: Blob; checksum: string; contentType: string } | undefined
    if (gridSource === detailSource && gridSource) {
      const shared = await sourceToBlobAndChecksum(gridSource)
      gridPre = shared
      detailPre = shared
    }
    if (needsGridUpload && gridSource) {
      gridImage = await directUpload(token, finalItem.id, 'grid', gridSource, finalItem.imageVersion, gridPre)
    }
    if (needsDetailUpload && detailSource) {
      detailImage = await directUpload(token, finalItem.id, 'detail', detailSource, finalItem.imageVersion, detailPre)
    }
  }
  const res = await workerApi<Product & { id: string }>('/products', {
    method: 'POST',
    token,
    body: { id: finalItem.id, designCode: finalItem.designCode, categoryId: finalItem.categoryId, subcategoryId: finalItem.subcategoryId, weightMg: finalItem.weightMg, gridImage, detailImage }
  })
  const savedProd: Product = {
    ...finalItem,
    id: res.id || finalItem.id,
    syncState: 'SYNCED',
    gridImageKey: gridImage.key,
    detailImageKey: detailImage.key,
    gridImageChecksum: gridImage.checksum,
    detailImageChecksum: detailImage.checksum,
    gridImageSizeBytes: gridImage.sizeBytes,
    detailImageSizeBytes: detailImage.sizeBytes
  }
  if (res.id && res.id !== finalItem.id) {
    await storage.remapProductId(finalItem.id, res.id, savedProd)
  } else {
    await storage.saveProduct(savedProd, false)
  }
  return res
}

export async function push(token: string, operation: Awaited<ReturnType<typeof storage.pendingOperations>>[number]) {
  const payload = JSON.parse(operation.payload) as Record<string, unknown>
  if (operation.entity_type === 'category') {
    if (operation.operation === 'ARCHIVE') {
      return workerApi(`/categories/${payload.id}/archive`, { method: 'POST', token })
    }
    if (operation.operation === 'RESTORE') {
      return workerApi(`/categories/${payload.id}/restore`, { method: 'POST', token })
    }
    const localCat = payload as unknown as Category
    const res = await workerApi<Category>('/categories', { method: 'POST', token, body: payload })
    if (res && res.id && res.id !== localCat.id) {
      await storage.remapCategoryId(localCat.id, res.id)
    }
    return res
  }
  if (operation.entity_type === 'subcategory') {
    if (operation.operation === 'ARCHIVE') {
      return workerApi(`/subcategories/${payload.id}/archive`, { method: 'POST', token })
    }
    if (operation.operation === 'RESTORE') {
      return workerApi(`/subcategories/${payload.id}/restore`, { method: 'POST', token })
    }
    const localSub = payload as unknown as Subcategory
    const res = await workerApi<Subcategory>('/subcategories', { method: 'POST', token, body: payload })
    if (res && res.id && res.id !== localSub.id) {
      await storage.remapSubcategoryId(localSub.id, res.id)
    }
    return res
  }
  if (operation.entity_type === 'vendor') {
    if (operation.operation === 'ARCHIVE') {
      return workerApi(`/vendors/${payload.id}/archive`, { method: 'POST', token })
    }
    if (operation.operation === 'RESTORE') {
      return workerApi(`/vendors/${payload.id}/restore`, { method: 'POST', token })
    }
    const localVendor = payload as unknown as Vendor
    const res = await workerApi<Vendor>('/vendors', { method: 'POST', token, body: payload })
    if (res && res.id && res.id !== localVendor.id) {
      await storage.remapVendorId(localVendor.id, res.id, res)
    }
    return res
  }
  if (operation.entity_type === 'presentation') {
    const order = payload as unknown as { id: string; orderNumber?: number; vendor: { id: string }; items: { productId: string; quantity: number; remark: string }[] }
    const res = await workerApi<Record<string, unknown>>('/orders', { method: 'POST', token, body: { id: order.id, vendorId: order.vendor.id, items: order.items.map(item => ({ productId: item.productId, quantity: item.quantity, remark: item.remark })) } })
    if (res && res.id) {
      if (res.id !== order.id) {
        await storage.remapOrderId(order.id, String(res.id), res)
      } else {
        await storage.applyRemoteChange({ entityType: 'presentation', entityId: String(res.id), operation: 'FINALIZE', payload: res })
      }
    }
    return res
  }
  if (operation.entity_type === 'product') {
    if (operation.operation === 'ARCHIVE') {
      return workerApi(`/products/${payload.id}/archive`, { method: 'POST', token })
    }
    if (operation.operation === 'RESTORE') {
      try {
        return await workerApi(`/products/${payload.id}/restore`, { method: 'POST', token })
      } catch (err) {
        if (err instanceof Error && (err.message.includes('not found') || err.message.includes('404'))) {
          return await uploadProductOnline(token, String(payload.id))
        }
        throw err
      }
    }
    const initialItem = (await storage.products()).find(x => x.id === payload.id) || (await storage.archivedProducts()).find(x => x.id === payload.id)
    if (!initialItem) return null
    return uploadProductOnline(token, String(payload.id))
  }
  throw new Error(`Unsupported queued operation: ${operation.entity_type}.`)
}

export async function uploadPendingProductImages(token: string) {
  const operations = (await storage.pendingOperations()).filter(operation => operation.entity_type === 'product')
  let uploaded = 0, failed = 0
  for (const operation of operations) {
    try {
      const res = await push(token, operation)
      await storage.completeOperation(operation.id)
      if (res) uploaded++
    } catch (error) {
      await storage.completeOperation(operation.id, error instanceof Error ? error.message : 'Upload failed')
      failed++
    }
  }
  return { uploaded, failed }
}

export async function initialDownload(token: string, onProgress?: (msg: string) => void) {
  onProgress?.('Downloading catalogue metadata...')
  const data = await workerApi<Bootstrap>('/sync/bootstrap', { token })

  for (const x of data.categories) await storage.applyRemoteChange({ entityType: 'category', entityId: String(x.id), operation: x.deleted_at ? 'ARCHIVE' : 'CREATE', payload: category(x) })
  for (const x of data.subcategories) await storage.applyRemoteChange({ entityType: 'subcategory', entityId: String(x.id), operation: x.deleted_at ? 'ARCHIVE' : 'CREATE', payload: subcategory(x) })
  for (const x of data.vendors) await storage.applyRemoteChange({ entityType: 'vendor', entityId: String(x.id), operation: x.deleted_at ? 'ARCHIVE' : 'CREATE', payload: vendor(x) })
  for (const x of data.presentations) await storage.applyRemoteChange({ entityType: 'presentation', entityId: String(x.id), operation: 'FINALIZE', payload: x })

  const activeProducts = data.products.filter(p => !p.deleted_at)
  let count = 0

  for (const x of data.products) {
    const p = productFromRecord(x)
    await storage.applyRemoteChange({ entityType: 'product', entityId: String(x.id), operation: x.deleted_at ? 'ARCHIVE' : 'CREATE', payload: p })
  }

  // Pre-cache grid images into local OPFS with SHA-256 verification
  for (const x of activeProducts) {
    count++
    const p = productFromRecord(x)
    if (p.gridImageKey) {
      const gridLocalPath = `${p.id}-grid-v${p.imageVersion}`
      const exists = await storage.hasImage(gridLocalPath)
      if (!exists) {
        onProgress?.(`Caching images (${count}/${activeProducts.length}): ${p.designCode}`)
        try {
          await storage.cacheRemoteImage(p.id, 'grid', p.gridImage, p.imageVersion, p.gridImageChecksum, p.gridImageSizeBytes)
        } catch (e) {
          console.warn(`Grid pre-cache failed for ${p.designCode}:`, e)
        }
      }
    }
  }

  await storage.setSyncCheckpoint(data.checkpoint)
  onProgress?.('Initial catalogue synchronization complete.')
}

export async function cloudImageStorageBytes(token: string) {
  const data = await workerApi<Bootstrap>('/sync/bootstrap', { token })
  return data.products.filter(product => !product.deleted_at).reduce((total, product) => total + Number(product.grid_image_size_bytes || 0) + Number(product.detail_image_size_bytes || 0), 0)
}

export async function synchronize(token: string, onProgress?: (msg: string) => void) {
  if (!navigator.onLine) return { synced: false, reason: 'offline' }

  // 1. Push offline queued operations
  onProgress?.('Uploading queued offline modifications...')
  const pending = await storage.pendingOperations()
  let uploaded = 0, failed = 0
  for (const operation of pending) {
    try {
      const res = await push(token, operation)
      await storage.completeOperation(operation.id)
      if (res) uploaded++
    } catch (error) {
      await storage.completeOperation(operation.id, error instanceof Error ? error.message : 'Sync failed')
      failed++
    }
  }

  // 2. Pull incremental updates from change feed
  onProgress?.('Checking cloud change feed...')
  const after = await storage.syncCheckpoint()
  const changes = await workerApi<Change[]>(`/sync/changes?after=${after}`, { token })

  for (const change of changes) {
    if (change.operation === 'ARCHIVE' || change.operation === 'DELETE') {
      await storage.applyRemoteChange({
        entityType: change.entity_type,
        entityId: change.entity_id,
        operation: 'ARCHIVE',
        payload: { id: change.entity_id }
      })
    } else {
      const parsed = JSON.parse(change.payload) as Record<string, unknown>
      if (change.entity_type === 'product') {
        const p = productFromRecord(parsed)
        await storage.applyRemoteChange({
          entityType: 'product',
          entityId: change.entity_id,
          operation: change.operation,
          payload: p
        })
        if (p.gridImageKey) {
          const gridLocalPath = `${p.id}-grid-v${p.imageVersion}`
          if (!(await storage.hasImage(gridLocalPath))) {
            try {
              await storage.cacheRemoteImage(p.id, 'grid', p.gridImage, p.imageVersion, p.gridImageChecksum, p.gridImageSizeBytes)
            } catch (err) {
              console.warn(`Incremental image cache failed for ${p.designCode}:`, err)
            }
          }
        }
      } else if (change.entity_type === 'category') {
        await storage.applyRemoteChange({ entityType: 'category', entityId: change.entity_id, operation: change.operation, payload: category(parsed) })
      } else if (change.entity_type === 'subcategory') {
        await storage.applyRemoteChange({ entityType: 'subcategory', entityId: change.entity_id, operation: change.operation, payload: subcategory(parsed) })
      } else if (change.entity_type === 'vendor') {
        await storage.applyRemoteChange({ entityType: 'vendor', entityId: change.entity_id, operation: change.operation, payload: vendor(parsed) })
      } else if (change.entity_type === 'presentation') {
        await storage.applyRemoteChange({ entityType: 'presentation', entityId: change.entity_id, operation: change.operation, payload: parsed })
      }
    }
    await storage.setSyncCheckpoint(change.sequence_number)
  }

  // 3. Ensure historical orders are synced
  await syncHistoryOrders(token)

  return { synced: true, uploaded, failed, pulled: changes.length }
}

export async function syncHistoryOrders(token: string) {
  try {
    const list = await workerApi<Array<{ id: string; order_number?: number }>>('/history', { token })
    const existingOrders = await storage.orders()
    const existingMap = new Map(existingOrders.map(o => [o.id, o]))
    const existingByNumber = new Map<number, Order>()
    for (const o of existingOrders) {
      if (o.orderNumber && o.orderNumber > 0) {
        existingByNumber.set(o.orderNumber, o)
      }
    }
    for (const h of list) {
      const existing = existingMap.get(h.id) || (h.order_number ? existingByNumber.get(h.order_number) : undefined)
      if (!existing || !existing.items || existing.items.length === 0 || existing.id !== h.id) {
        try {
          const detail = await workerApi<{ presentation: Record<string, unknown>; items: Record<string, unknown>[] }>(`/orders/${h.id}`, { token })
          if (detail?.presentation) {
            if (existing && existing.id !== h.id) {
              await storage.remapOrderId(existing.id, h.id, { ...detail.presentation, items: detail.items || [] })
            } else {
              await storage.applyRemoteChange({
                entityType: 'presentation',
                entityId: h.id,
                operation: 'FINALIZE',
                payload: { ...detail.presentation, items: detail.items || [] }
              })
            }
          }
        } catch (err) {
          console.warn(`Failed to sync order detail for ${h.id}:`, err)
        }
      }
    }
  } catch (err) {
    console.warn('History order sync failed:', err)
  }
}

export async function recoverMissingImages(token: string, onProgress?: (msg: string) => void) {
  if (!navigator.onLine) throw new Error('Cannot run image recovery while offline.')
  const products = await storage.products()
  let recovered = 0, failed = 0
  for (const p of products) {
    if (p.deleted) continue
    const gridPath = `${p.id}-grid-v${p.imageVersion}`
    const detailPath = `${p.id}-detail-v${p.imageVersion}`

    if (!(await storage.hasImage(gridPath)) && p.gridImageKey) {
      onProgress?.(`Recovering grid thumbnail for ${p.designCode}...`)
      try {
        const meta = await workerApi<{ available: boolean; url: string; sizeBytes: number; checksum: string }>(`/images/${encodeURIComponent(p.gridImageKey)}/recovery`, { token })
        if (meta.available && meta.url) {
          await storage.cacheRemoteImage(p.id, 'grid', meta.url, p.imageVersion, meta.checksum, meta.sizeBytes)
          recovered++
        }
      } catch (err) {
        console.warn(`Grid recovery error for ${p.designCode}:`, err)
        failed++
      }
    }

    if (!(await storage.hasImage(detailPath)) && p.detailImageKey) {
      onProgress?.(`Recovering detail asset for ${p.designCode}...`)
      try {
        const meta = await workerApi<{ available: boolean; url: string; sizeBytes: number; checksum: string }>(`/images/${encodeURIComponent(p.detailImageKey)}/recovery`, { token })
        if (meta.available && meta.url) {
          await storage.cacheRemoteImage(p.id, 'detail', meta.url, p.imageVersion, meta.checksum, meta.sizeBytes)
          recovered++
        }
      } catch (err) {
        console.warn(`Detail recovery error for ${p.designCode}:`, err)
        failed++
      }
    }
  }
  return { recovered, failed }
}
