// Naming rules for the on-device image files. Pure functions (no browser APIs) so they are unit-testable
// and shared by the page and the image worker.
//
// Every file is named  <productId>.<kind>.<signature>
//   kind       t360q78 = grid thumbnail made on this device · detail = high-res · grid = 600px upload source
//              (kept only until the product has reached the cloud)
//   signature  first 16 hex chars of the cloud SHA-256 checksum. A replaced photo has a new checksum, so it gets
//              a new file name and the old picture can never be shown for it. (image_version is NOT reliable:
//              the server does not bump it on an image replace.)
import type { Product } from './types'

export type ImageRep = 'thumb' | 'detail' | 'grid'

/** Grid thumbnail spec, chosen on real catalogue photos. Changing either value renames (= regenerates) every thumbnail. */
export const THUMB_MAX_SIDE = 360
export const THUMB_QUALITY = 0.78

const KIND: Record<ImageRep, string> = { thumb: `t${THUMB_MAX_SIDE}q${Math.round(THUMB_QUALITY * 100)}`, detail: 'detail', grid: 'grid' }
export const THUMB_KIND = KIND.thumb
export const IMAGE_DIR = 'sj-images-v2'
/** Folder used before the binary image store: text files holding base64 data URLs. Read once for migration, then removed. */
export const LEGACY_IMAGE_DIR = 'shine-jewels-images'

const R2_BASE = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_R2_PUBLIC_BASE_URL || 'https://pub-ddd4389cc31a46b6b365e21911f96e1f.r2.dev').replace(/\/$/, '')
export const cloudImageUrl = (key: string) => `${R2_BASE}/${key.split('/').map(encodeURIComponent).join('/')}`

export const safeImageId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_')

function hash32(text: string, seed: number) {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

/** Identifies the exact picture a file was made from: cloud checksum, else cloud key, else the local image version. */
export function sourceSignature(checksum: string | undefined, key: string | undefined, version: number | undefined): string {
  if (checksum && /^[a-f0-9]{64}$/i.test(checksum)) return checksum.slice(0, 16).toLowerCase()
  if (key) return `k${hash32(key, 0x811c9dc5)}${hash32(key, 0x01234567)}`
  return `l${Math.max(1, Number(version) || 1)}`
}

export function imageName(product: Pick<Product, 'id' | 'imageVersion' | 'gridImageKey' | 'detailImageKey' | 'gridImageChecksum' | 'detailImageChecksum'>, rep: ImageRep): string {
  const signature = rep === 'detail'
    ? sourceSignature(product.detailImageChecksum, product.detailImageKey, product.imageVersion)
    : sourceSignature(product.gridImageChecksum, product.gridImageKey, product.imageVersion)
  return `${safeImageId(product.id)}.${KIND[rep]}.${signature}`
}

export const productIdOfImage = (name: string) => name.slice(0, name.indexOf('.'))
export const isThumbName = (name: string) => name.split('.')[1] === KIND.thumb
export const isDetailName = (name: string) => name.split('.')[1] === 'detail'

/** One file this device should hold, and every place its bytes can come from. */
export type WantedImage = {
  name: string
  rep: ImageRep
  /** Cloud address, or null while the product exists only on this device. */
  url: string | null
  checksum?: string
  sizeBytes?: number
  /** File name in the pre-migration text store. */
  legacy: string
  /** Thumbnails only: the local 600px upload source, when the product was created on this device. */
  localSource?: string
}

export function wantedImages(product: Product): WantedImage[] {
  const version = product.imageVersion || 1
  const legacyGrid = `${product.id}-grid-v${version}`, legacyDetail = `${product.id}-detail-v${version}`
  const out: WantedImage[] = []
  const gridSource = imageName(product, 'grid')
  if (!product.gridImageKey) out.push({ name: gridSource, rep: 'grid', url: null, legacy: legacyGrid })
  out.push({
    name: imageName(product, 'thumb'), rep: 'thumb', url: product.gridImageKey ? cloudImageUrl(product.gridImageKey) : null,
    checksum: product.gridImageChecksum, sizeBytes: product.gridImageSizeBytes, legacy: legacyGrid, localSource: product.gridImageKey ? undefined : gridSource
  })
  out.push({
    name: imageName(product, 'detail'), rep: 'detail', url: product.detailImageKey ? cloudImageUrl(product.detailImageKey) : null,
    checksum: product.detailImageChecksum, sizeBytes: product.detailImageSizeBytes, legacy: legacyDetail
  })
  return out
}

/** Thumbnails made by the canvas encoder always end with the JPEG end-of-image marker; a cut-off write does not. */
export function looksLikeCompleteJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length
  return n > 100 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9
}
