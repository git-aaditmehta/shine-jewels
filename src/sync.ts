
import { isSignInError, workerApi } from './api'
import { storage } from './storage'
import { imageStore, sha256Hex } from './image-store'
import { cloudImageUrl } from './image-names'
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

export async function computeSha256(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? await (await fetch(data)).arrayBuffer() : data
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
}

type UploadSource = { blob: Blob; checksum: string; contentType: string }

async function uploadSource(blob: Blob): Promise<UploadSource> {
  return { blob, checksum: await sha256Hex(new Uint8Array(await blob.arrayBuffer())), contentType: blob.type || 'image/jpeg' }
}

async function directUpload(token: string, productId: string, representation: 'grid' | 'detail', version: number, source: UploadSource) {
  const { blob, checksum, contentType } = source
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

// Cloud ids of categories/subcategories confirmed in the last few minutes, so a batch of uploads asks once, not per product.
const taxonomyIds = new Map<string, { id: string; at: number }>()
async function cloudTaxonomyId(cacheKey: string, ask: () => Promise<Record<string, unknown>>): Promise<string> {
  const known = taxonomyIds.get(cacheKey)
  if (known && Date.now() - known.at < 5 * 60_000) return known.id
  const remote = await ask()
  if (!remote?.id) throw new Error('The cloud did not confirm the category for this design.')
  const id = String(remote.id)
  taxonomyIds.set(cacheKey, { id, at: Date.now() })
  return id
}

/** A design kept on this device instead of being uploaded, because a different cloud design already uses its code. */
export class HeldBackError extends Error {
  readonly cloudId: string
  constructor(designCode: string, cloudId: string) { super(`Design ${designCode} was kept on this device: a different design with this code is already in the cloud.`); this.name = 'HeldBackError'; this.cloudId = cloudId }
}

export async function uploadProductOnline(token: string, productId: string): Promise<Product & { id: string }> {
  const initialItem = await storage.productRecord(productId)
  if (!initialItem) throw new Error('Product not found locally.')

  // The cloud matches designs by id or by design code. If a *different* cloud design already has this code, uploading
  // would overwrite that design's photos and weight, so the design is held back on this device for a decision instead.
  // Checked before any photo is sent, so nothing is uploaded for a held-back design.
  const clash = await workerApi<{ product: { id: string; designCode: string } | null }>(`/products/by-code?code=${encodeURIComponent(initialItem.designCode.trim())}`, { token })
  if (clash.product && clash.product.id !== initialItem.id) {
    await storage.holdBackProduct(initialItem.id, clash.product.id)
    throw new HeldBackError(initialItem.designCode, clash.product.id)
  }
  const categories = await storage.categories(), subcategories = await storage.subcategories()
  const localCategory = categories.find(x => x.id === initialItem.categoryId)
  const localSubcategory = subcategories.find(x => x.id === initialItem.subcategoryId)
  if (!localCategory || !localSubcategory) throw new Error('Product category or subcategory is missing locally.')

  // The server's "create category" call returns the existing one when the id or name already exists, so it is used to
  // look the cloud id up. (This used to download the entire catalogue for every single product upload.)
  const remoteCategoryId = await cloudTaxonomyId(`c:${localCategory.id}:${localCategory.name}`, () => workerApi<Record<string, unknown>>('/categories', { method: 'POST', token, body: { id: localCategory.id, name: localCategory.name } }))
  await storage.remapCategoryId(localCategory.id, remoteCategoryId)

  const remappedItem = await storage.productRecord(productId)
  if (!remappedItem) throw new Error('Product lost during category remap.')
  const targetCategoryId = remappedItem.categoryId
  const remoteSubcategoryId = await cloudTaxonomyId(`s:${localSubcategory.id}:${targetCategoryId}:${localSubcategory.name}`, () => workerApi<Record<string, unknown>>('/subcategories', { method: 'POST', token, body: { id: localSubcategory.id, name: localSubcategory.name, categoryId: targetCategoryId } }))
  await storage.remapSubcategoryId(localSubcategory.id, remoteSubcategoryId)

  const finalItem = await storage.productRecord(productId)
  if (!finalItem) throw new Error('Product lost during subcategory remap.')

  let gridImage = { key: finalItem.gridImageKey || '', sizeBytes: finalItem.gridImageSizeBytes || 0, checksum: finalItem.gridImageChecksum || '' }
  let detailImage = { key: finalItem.detailImageKey || '', sizeBytes: finalItem.detailImageSizeBytes || 0, checksum: finalItem.detailImageChecksum || '' }

  // Photos that have never reached the cloud live only in this device's image store.
  const needsGridUpload = !finalItem.gridImageKey
  const needsDetailUpload = !finalItem.detailImageKey || (finalItem.detailImageSizeBytes !== undefined && finalItem.detailImageSizeBytes > 0 && finalItem.detailImageSizeBytes < 1000)

  if (needsGridUpload || needsDetailUpload) {
    // Makes sure photos saved by an older app version have been moved into the image store first.
    await imageStore.ensure(finalItem, ['grid', 'thumb', 'detail'])
    let gridBlob = await imageStore.blob(finalItem, 'grid')
    let detailBlob = await imageStore.blob(finalItem, 'detail')
    // Already-uploaded picture that is not on this device (e.g. repairing a damaged cloud copy): take it from the cloud.
    const fromCloud = async (key?: string) => { if (!key) return null; try { const r = await fetch(cloudImageUrl(key)); return r.ok ? await r.blob() : null } catch { return null } }
    if (!gridBlob) gridBlob = await fromCloud(finalItem.gridImageKey)
    if (!detailBlob) detailBlob = gridBlob
    if (!gridBlob) gridBlob = detailBlob
    if (!gridBlob || !detailBlob) throw new Error(`The photo for ${finalItem.designCode} is missing on this device. Open the design and choose the photo again.`)
    const gridSource = await uploadSource(gridBlob), detailSource = detailBlob === gridBlob ? gridSource : await uploadSource(detailBlob)
    if (needsGridUpload) gridImage = await directUpload(token, finalItem.id, 'grid', finalItem.imageVersion, gridSource)
    if (needsDetailUpload) detailImage = await directUpload(token, finalItem.id, 'detail', finalItem.imageVersion, detailSource)
  }
  const res = await workerApi<Product & { id: string }>('/products', {
    method: 'POST',
    token,
    body: { id: finalItem.id, designCode: finalItem.designCode, categoryId: finalItem.categoryId, subcategoryId: finalItem.subcategoryId, weightMg: finalItem.weightMg, gridImage, detailImage }
  })
  const savedProd: Product = {
    ...finalItem,
    id: res.id || finalItem.id,
    gridImage: '',
    detailImage: '',
    syncState: 'SYNCED',
    gridImageKey: gridImage.key,
    detailImageKey: detailImage.key,
    gridImageChecksum: gridImage.checksum,
    detailImageChecksum: detailImage.checksum,
    gridImageSizeBytes: gridImage.sizeBytes,
    detailImageSizeBytes: detailImage.sizeBytes
  }
  // The files already on this device stay valid; rename them if the id or checksums changed with the upload.
  await imageStore.adopt(finalItem, savedProd)
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
    if (operation.operation === 'ARCHIVE' || operation.operation === 'DELETE') {
      return workerApi(`/categories/${payload.id}`, { method: 'DELETE', token })
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
    if (operation.operation === 'ARCHIVE' || operation.operation === 'DELETE') {
      return workerApi(`/subcategories/${payload.id}`, { method: 'DELETE', token })
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
    if (operation.operation === 'ARCHIVE' || operation.operation === 'DELETE') {
      return workerApi(`/vendors/${payload.id}`, { method: 'DELETE', token })
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
    if (operation.operation === 'ARCHIVE' || operation.operation === 'DELETE') {
      return workerApi(`/products/${payload.id}`, { method: 'DELETE', token })
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
  onProgress?.('Downloading catalogue…')
  const data = await workerApi<Bootstrap>('/sync/bootstrap', { token })

  // Catalogue details only. Photos are not downloaded here: the background downloader fetches thumbnails first and
  // high-res afterwards, so the catalogue opens straight away and an interrupted download simply continues later.
  const CHUNK = 500
  const apply = async <T,>(items: T[], save: (item: T) => Promise<void>) => {
    for (let i = 0; i < items.length; i += CHUNK) await storage.bulk(async () => { for (const item of items.slice(i, i + CHUNK)) await save(item) })
  }
  await apply(data.categories, x => storage.applyRemoteChange({ entityType: 'category', entityId: String(x.id), operation: x.deleted_at ? 'ARCHIVE' : 'CREATE', payload: category(x) }))
  await apply(data.subcategories, x => storage.applyRemoteChange({ entityType: 'subcategory', entityId: String(x.id), operation: x.deleted_at ? 'ARCHIVE' : 'CREATE', payload: subcategory(x) }))
  await apply(data.vendors, x => storage.applyRemoteChange({ entityType: 'vendor', entityId: String(x.id), operation: x.deleted_at ? 'ARCHIVE' : 'CREATE', payload: vendor(x) }))
  await apply(data.presentations, x => storage.applyRemoteChange({ entityType: 'presentation', entityId: String(x.id), operation: 'FINALIZE', payload: x }))
  await apply(data.products, x => storage.applyRemoteChange({ entityType: 'product', entityId: String(x.id), operation: x.deleted_at ? 'ARCHIVE' : 'CREATE', payload: productFromRecord(x) }))

  await storage.setSyncCheckpoint(data.checkpoint)
  onProgress?.('Catalogue ready. Photos continue downloading in the background.')
}

/** Size of the catalogue's photos in the cloud, from the product details already synced to this device. */
export function cloudImageStorageBytes(products: Product[]) {
  return products.filter(product => !product.deleted && product.gridImageKey).reduce((total, product) => total + Number(product.gridImageSizeBytes || 0) + Number(product.detailImageSizeBytes || 0), 0)
}

export async function synchronize(token: string, onProgress?: (msg: string) => void) {
  if (!navigator.onLine) return { synced: false, reason: 'offline' }

  // 1. Push offline queued operations
  // The queue is read 100 at a time; keep going until everything waiting has been tried once in this sync (a device that
  // was offline or signed out for weeks can have hundreds of designs waiting).
  onProgress?.('Uploading queued offline modifications...')
  let uploaded = 0, failed = 0, heldBack = 0
  const tried = new Set<string>()
  for (let round = 0; round < 200; round++) {
    const pending = (await storage.pendingOperations()).filter(operation => !tried.has(operation.id))
    if (!pending.length) break
    for (const operation of pending) {
      tried.add(operation.id)
      try {
        const res = await push(token, operation)
        await storage.completeOperation(operation.id)
        if (res) uploaded++
      } catch (error) {
        // Signed out: stop here and leave the queue exactly as it is. A rejected sign-in is not the upload's fault, so it
        // must not use up the operation's retries.
        if (isSignInError(error)) throw error
        if (error instanceof HeldBackError) { await storage.completeOperation(operation.id); heldBack++; continue }
        await storage.completeOperation(operation.id, error instanceof Error ? error.message : 'Sync failed')
        failed++
      }
      if ((uploaded + failed + heldBack) % 5 === 0) onProgress?.(`Uploading saved changes… ${uploaded} uploaded${failed ? `, ${failed} will retry` : ''}${heldBack ? `, ${heldBack} kept on device` : ''}`)
    }
  }

  // 2. Pull incremental updates from change feed
  onProgress?.('Checking cloud change feed...')
  // The server returns at most 500 changes per call: keep asking until this device has caught up.
  let pulled = 0
  for (let page = 0; page < 200; page++) {
    const after = await storage.syncCheckpoint()
    const changes = await workerApi<Change[]>(`/sync/changes?after=${after}`, { token })
    pulled += changes.length
    await storage.bulk(async () => {
      for (const change of changes) {
        if (change.operation === 'ARCHIVE' || change.operation === 'DELETE') {
          await storage.applyRemoteChange({
            entityType: change.entity_type,
            entityId: change.entity_id,
            operation: 'DELETE',
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
    })
    if (changes.length < 500) break
  }

  // 3. Ensure historical orders are synced
  await syncHistoryOrders(token)

  // 4. Photos: nothing to do here. The image downloader compares the catalogue with the files on this device after
  //    every reload of the product list and fetches whatever is new, replaced or missing.

  return { synced: true, uploaded, failed, heldBack, pulled }
}

export async function syncHistoryOrders(token: string) {
  try {
    const list = await workerApi<Array<{ id: string; order_number?: number }>>('/history', { token })
    const existingOrders = await storage.orders()
    const existingMap = new Map(existingOrders.map(o => [o.id, o]))
    const existingByNumber = new Map<number, Order>()
    // An order still waiting to upload is never matched by number: it is a different order that happens to share it.
    const pending = await storage.pendingOrderIds()
    for (const o of existingOrders) {
      if (o.orderNumber && o.orderNumber > 0 && !pending.has(o.id)) {
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
