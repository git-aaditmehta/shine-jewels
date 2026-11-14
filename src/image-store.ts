// Page-side access to the on-device image files.
//  - Reads go straight to the private file system (fast, no worker round trip) and become short-lived object URLs.
//    Only a few hundred small thumbnails are ever held in memory, however large the catalogue is.
//  - Writes, downloads, resizing and clean-up all happen in the image worker.
import { IMAGE_DIR, imageName, isThumbName, looksLikeCompleteJpeg, safeImageId, wantedImages, type ImageRep, type WantedImage } from './image-names'
import type { ImageProgress } from './image-worker'
import type { Product } from './types'

export type { ImageProgress }

const THUMB_URL_LIMIT = 400
const DETAIL_URL_LIMIT = 6
const EMPTY: ImageProgress = { state: 'idle', thumbs: { ready: 0, total: 0 }, details: { ready: 0, total: 0 }, failed: 0, lost: 0, migrating: false }

async function resizeOnPage(buffer: ArrayBuffer, maxSide: number, quality: number): Promise<ArrayBuffer | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([buffer]))
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    return blob ? await blob.arrayBuffer() : null
  } catch { return null }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))
  let hex = ''
  for (const b of digest) hex += b.toString(16).padStart(2, '0')
  return hex
}

export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; contentType: string } {
  const comma = dataUrl.indexOf(',')
  const contentType = dataUrl.slice(0, comma).match(/:(.*?);/)?.[1] || 'image/jpeg'
  const binary = atob(dataUrl.slice(comma + 1)), bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { bytes, contentType }
}

const blobToDataUrl = (blob: Blob) => new Promise<string | null>(resolve => {
  const reader = new FileReader()
  reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null)
  reader.onerror = () => resolve(null)
  reader.readAsDataURL(blob)
})

class ImageStore {
  private readonly worker: Worker | null = typeof Worker !== 'undefined' ? new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' }) : null
  private seq = 0
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void }>()
  private directory: Promise<FileSystemDirectoryHandle | null> | null = null
  private readonly urls = new Map<string, string>() // insertion order = least recently used first
  private readonly refs = new Map<string, number>()
  private readonly loading = new Map<string, Promise<string | null>>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly progressListeners = new Set<() => void>()
  private progressValue: ImageProgress = EMPTY
  private missing: string[] = []
  private missingTimer: ReturnType<typeof setTimeout> | null = null
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private readonly opfs: Promise<boolean>

  constructor() {
    this.worker?.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { id?: number; event?: string; error?: string } & Record<string, unknown>
      if (data.event === 'progress') { this.progressValue = data.progress as ImageProgress; for (const listener of this.progressListeners) listener(); return }
      if (data.event === 'ready') { for (const name of data.names as string[]) { this.drop(name); this.listeners.get(name)?.forEach(listener => listener()) } return }
      if (data.event === 'need-resize') {
        void resizeOnPage(data.bytes as ArrayBuffer, data.maxSide as number, data.quality as number)
          .then(bytes => this.worker!.postMessage({ op: 'resized', jobId: data.jobId, bytes }, bytes ? [bytes] : []))
        return
      }
      const task = this.pending.get(data.id!)
      if (!task) return
      this.pending.delete(data.id!)
      if (data.error) task.reject(new Error(data.error)); else task.resolve(data)
    })
    let forceMainResize = false
    try { forceMainResize = typeof localStorage !== 'undefined' && localStorage.getItem('sj.forceMainResize') === '1' } catch { /* storage blocked */ }
    let failWritesAfter: number | undefined
    try { const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('sj.debugFailWritesAfter') : null; if (raw !== null) failWritesAfter = Number(raw) } catch { /* storage blocked */ }
    this.opfs = this.request('init', { forceMainResize, failWritesAfter }).then(reply => Boolean(reply.opfs)).catch(() => false)
    if (typeof window !== 'undefined') (window as unknown as { __sjImages?: unknown }).__sjImages = { progress: () => this.progressValue, cachedUrls: () => this.urls.size }
  }

  private request(op: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []) {
    if (!this.worker) return Promise.reject(new Error('Image worker is unavailable in this runtime.'))
    const id = ++this.seq
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, op, ...payload }, transfer)
    })
  }

  private folder() {
    if (!this.directory) {
      this.directory = this.opfs.then(async ok => {
        if (!ok) return null
        try { return await (await navigator.storage.getDirectory()).getDirectoryHandle(IMAGE_DIR, { create: true }) } catch { return null }
      })
    }
    return this.directory
  }

  /** Raw file bytes, or null when the file is not on this device (yet). */
  async bytes(name: string, expectedSize?: number): Promise<Uint8Array | null> {
    let bytes: Uint8Array | null = null
    const folder = await this.folder()
    if (folder) {
      try { bytes = new Uint8Array(await (await (await folder.getFileHandle(name)).getFile()).arrayBuffer()) } catch { bytes = null }
    } else {
      const reply = await this.request('read', { name }).catch(() => null)
      bytes = reply?.bytes ? new Uint8Array(reply.bytes as ArrayBuffer) : null
    }
    if (!bytes) return null
    // A write cut off by the app being closed leaves a short file: delete it and let the downloader fetch it again.
    const valid = isThumbName(name) ? looksLikeCompleteJpeg(bytes) : bytes.length > 0 && (!expectedSize || bytes.length === expectedSize)
    if (!valid) { void this.request('invalidate', { name }).catch(() => {}); return null }
    return bytes
  }

  private drop(name: string) {
    const url = this.urls.get(name)
    if (url) { this.urls.delete(name); URL.revokeObjectURL(url) }
  }

  private remember(name: string, url: string) {
    this.urls.set(name, url)
    const thumb = isThumbName(name)
    let count = 0
    for (const key of this.urls.keys()) if (isThumbName(key) === thumb) count++
    const limit = thumb ? THUMB_URL_LIMIT : DETAIL_URL_LIMIT
    if (count <= limit) return
    for (const key of [...this.urls.keys()]) {
      if (count <= limit) break
      if (isThumbName(key) !== thumb || key === name || this.refs.get(key)) continue
      this.drop(key); count--
    }
  }

  /** Cached object URL, if this file was shown recently. Synchronous, so a re-mounted tile paints with no flash. */
  peek(name: string): string | null {
    const url = this.urls.get(name)
    if (!url) return null
    this.urls.delete(name); this.urls.set(name, url)
    return url
  }

  /** Object URL for a stored file; null when it is not on the device yet (the downloader is told to fetch it first). */
  url(name: string, expectedSize?: number): Promise<string | null> {
    const cached = this.peek(name)
    if (cached) return Promise.resolve(cached)
    let task = this.loading.get(name)
    if (!task) {
      task = this.bytes(name, expectedSize).then(bytes => {
        if (!bytes) { this.noteMissing(name); return null }
        const url = URL.createObjectURL(new Blob([bytes as unknown as ArrayBuffer], { type: 'image/jpeg' }))
        this.remember(name, url)
        return url
      }).catch(() => null).finally(() => this.loading.delete(name))
      this.loading.set(name, task)
    }
    return task
  }

  /** Warm the URL cache for tiles that are about to scroll into view. */
  prefetch(names: string[]) {
    for (const name of names) if (!this.urls.has(name) && !this.loading.has(name)) void this.url(name)
  }

  retain(name: string) { this.refs.set(name, (this.refs.get(name) || 0) + 1) }
  release(name: string) { const n = (this.refs.get(name) || 0) - 1; if (n > 0) this.refs.set(name, n); else this.refs.delete(name) }

  /** Called when the worker has (re)written `name`. */
  subscribe(name: string, listener: () => void) {
    let set = this.listeners.get(name)
    if (!set) { set = new Set(); this.listeners.set(name, set) }
    set.add(listener)
    return () => { set!.delete(listener); if (!set!.size) this.listeners.delete(name) }
  }

  /** Photos the user is looking at right now jump the download queue. */
  private noteMissing(name: string) {
    this.missing.push(name)
    if (this.missingTimer) return
    this.missingTimer = setTimeout(() => { this.missingTimer = null; void this.request('prioritize', { names: this.missing.splice(0) }).catch(() => {}) }, 120)
  }

  /** Tell the downloader which files this device should hold. Safe to call often; an empty list is ignored. */
  sync(products: Product[]) {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      const wanted: WantedImage[] = []
      for (const product of products) if (!product.deleted || !product.gridImageKey || !product.detailImageKey) wanted.push(...wantedImages(product))
      if (wanted.length) void this.request('sync', { wanted }).catch(() => {})
    }, 250)
  }

  /** Fetch (or migrate) specific files now, ahead of the queue. Resolves true when every one is on the device. */
  async ensure(product: Product, reps: ImageRep[]): Promise<boolean> {
    const items = wantedImages(product).filter(item => reps.includes(item.rep))
    if (!items.length) return true
    const reply = await this.request('ensure', { items }).catch(() => null)
    return Boolean(reply && (reply.results as boolean[]).every(Boolean))
  }

  async blob(product: Product, rep: ImageRep): Promise<Blob | null> {
    const bytes = await this.bytes(imageName(product, rep), rep === 'detail' ? product.detailImageSizeBytes : undefined)
    return bytes ? new Blob([bytes as unknown as ArrayBuffer], { type: 'image/jpeg' }) : null
  }

  async dataUrl(product: Product, rep: ImageRep): Promise<string | null> {
    const blob = await this.blob(product, rep)
    return blob ? blobToDataUrl(blob) : null
  }

  /** Store the photos of a product created or re-photographed on this device (not yet in the cloud). */
  async saveLocal(product: Product, grid: Uint8Array, detail: Uint8Array) {
    await this.request('put', { files: [{ name: imageName(product, 'grid'), bytes: grid.slice().buffer }, { name: imageName(product, 'detail'), bytes: detail.slice().buffer }] })
    await this.request('thumb', { name: imageName(product, 'thumb'), bytes: grid.slice().buffer })
  }

  /** After an upload the product's id or checksums can change; keep the already-stored files instead of re-downloading. */
  async adopt(before: Product, after: Product) {
    const pairs = (['thumb', 'detail'] as const).map(rep => [imageName(before, rep), imageName(after, rep)]).filter(([from, to]) => from !== to)
    if (pairs.length) await this.request('rename', { pairs }).catch(() => {})
  }

  async removeProduct(productId: string) {
    const prefix = `${safeImageId(productId)}.`
    for (const name of [...this.urls.keys()]) if (name.startsWith(prefix)) this.drop(name)
    await this.request('delete-product', { productId: safeImageId(productId) }).catch(() => {})
  }

  async wipe() {
    for (const name of [...this.urls.keys()]) this.drop(name)
    await this.request('wipe').catch(() => {})
  }

  /** Re-read the folder and fetch anything missing or damaged. */
  rescan() { return this.request('rescan').then(() => undefined).catch(() => undefined) }

  progress = () => this.progressValue
  onProgress = (listener: () => void) => { this.progressListeners.add(listener); return () => { this.progressListeners.delete(listener) } }

  /** Space used by this app and the space the system allows it, when the browser reports them. */
  async usage(): Promise<{ usage: number; quota: number } | null> {
    try {
      const estimate = await navigator.storage?.estimate?.()
      return estimate && typeof estimate.usage === 'number' ? { usage: estimate.usage, quota: estimate.quota || 0 } : null
    } catch { return null }
  }
}

export const imageStore = new ImageStore()
