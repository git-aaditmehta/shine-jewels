import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import { imageName } from './image-names'
import { imageStore, type ImageProgress } from './image-store'
import type { Product } from './types'

/** Object URL of a file in the on-device image store, or null while it is not available yet. */
export function useStoredImage(name: string | null, expectedSize?: number): string | null {
  const [loaded, setLoaded] = useState<{ name: string; url: string } | null>(null)
  useEffect(() => {
    if (!name) return
    let alive = true
    const load = () => { void imageStore.url(name, expectedSize).then(url => { if (alive) setLoaded(url ? { name, url } : null) }) }
    imageStore.retain(name)
    load()
    const unsubscribe = imageStore.subscribe(name, load)
    return () => { alive = false; unsubscribe(); imageStore.release(name) }
  }, [name, expectedSize])
  if (!name) return null
  if (loaded?.name === name) return loaded.url
  return imageStore.peek(name)
}

type ThumbProps = { product: Product; alt?: string; className?: string }

/** Grid thumbnail read from this device only (never the network). Shows a quiet placeholder until the file exists. */
export const ProductThumb = memo(function ProductThumb({ product, alt, className }: ThumbProps) {
  const url = useStoredImage(imageName(product, 'thumb'))
  return url
    ? <img src={url} alt={alt ?? product.designCode} className={className} decoding="async" draggable={false} />
    : <img alt="" aria-label={alt ?? product.designCode} className={`thumb-pending${className ? ` ${className}` : ''}`} draggable={false} />
})

/** High-res photo when it is on the device, otherwise the thumbnail. */
export function ProductPhoto({ product, alt, className }: ThumbProps) {
  const detail = useStoredImage(imageName(product, 'detail'), product.detailImageSizeBytes)
  const thumb = useStoredImage(imageName(product, 'thumb'))
  const url = detail || thumb
  return url
    ? <img src={url} alt={alt ?? product.designCode} className={className} draggable={false} />
    : <img alt="" aria-label={alt ?? product.designCode} className={`thumb-pending${className ? ` ${className}` : ''}`} draggable={false} />
}

export function useImageProgress(): ImageProgress {
  return useSyncExternalStore(imageStore.onProgress, imageStore.progress, imageStore.progress)
}

const count = (n: number) => n.toLocaleString('en-IN')
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`

function statusLine(p: ImageProgress): string {
  const waiting = (p.thumbs.total - p.thumbs.ready) + (p.details.total - p.details.ready)
  if (p.state === 'storage-full') return 'This device is out of space. Free some storage, then tap “Check & Repair Photos”.'
  if (p.state === 'paused-offline') return `No internet — ${count(waiting)} photo(s) will download automatically when the connection returns.`
  if (p.state === 'working') return p.migrating ? 'Updating the photos on this device to the faster format…' : (p.lastError || 'Downloading photos in the background. You can keep using the app.')
  if (p.lost > 0) return `${count(p.lost)} photo(s) of designs not yet uploaded could not be found on this device.`
  if (p.failed > 0) return `${count(p.failed)} photo(s) could not be downloaded. They are retried automatically.`
  if (p.state === 'complete') return 'Every photo is stored on this device and works offline.'
  return 'Waiting for the catalogue.'
}

/** Small pill beside the design count. Only visible while photos are still arriving. */
export function ImageSyncBadge() {
  const p = useImageProgress()
  if (!p.thumbs.total || (p.thumbs.ready >= p.thumbs.total && p.details.ready >= p.details.total)) return null
  const thumbsDone = p.thumbs.ready >= p.thumbs.total
  const label = thumbsDone ? `High-res ${count(p.details.ready)} / ${count(p.details.total)}` : `Photos ${count(p.thumbs.ready)} / ${count(p.thumbs.total)}`
  return <span className={`image-sync-badge ${p.state}`} title={statusLine(p)}>{p.state === 'paused-offline' ? 'Offline · ' : ''}{label}</span>
}

/** Storage screen: how much of the catalogue is on this device, and how much space it uses. */
export function ImageSyncPanel() {
  const p = useImageProgress()
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  useEffect(() => {
    let alive = true
    const read = () => { void imageStore.usage().then(u => { if (alive) setUsage(u) }) }
    read()
    const timer = setInterval(read, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const bar = (ready: number, total: number) => <div className="image-sync-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={ready}><i style={{ width: `${total ? Math.round(100 * ready / total) : 0}%` }} /></div>
  const free = usage && usage.quota ? usage.quota - usage.usage : null
  return (
    <div className="image-sync-panel">
      <strong>{count(p.thumbs.ready)} / {count(p.thumbs.total)}</strong><span>Catalogue photos ready offline</span>{bar(p.thumbs.ready, p.thumbs.total)}
      <strong>{count(p.details.ready)} / {count(p.details.total)}</strong><span>High-resolution photos ready offline</span>{bar(p.details.ready, p.details.total)}
      <p className={`image-sync-status ${p.state}`}>{statusLine(p)}</p>
      {usage && <p>This app is using <b>{size(usage.usage)}</b> on this device{free !== null && <> · <b>{size(free)}</b> still available to it</>}.</p>}
      {free !== null && free < 500 * 1024 ** 2 && <p className="image-sync-status storage-full">Storage is running low on this device. Free some space so new photos can be saved.</p>}
    </div>
  )
}
