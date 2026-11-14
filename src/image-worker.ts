// Image worker: owns every write to the on-device image folder and runs the background downloader.
// Nothing here touches the page thread, so scrolling stays smooth while thousands of photos are fetched,
// checked, resized and written.
//
// The folder is the single source of truth: a file exists under its final name only after its bytes were
// verified. "What is missing" is always recomputed from the folder listing, so an interrupted download
// (app closed, iPad restarted, network lost) simply continues on the next run.
import { IMAGE_DIR, LEGACY_IMAGE_DIR, THUMB_MAX_SIDE, THUMB_QUALITY, isDetailName, isThumbName, productIdOfImage, type WantedImage } from './image-names'

type SyncHandle = { truncate(n: number): void; write(b: Uint8Array, o?: { at: number }): number; flush(): void; close(): void }
type Scope = {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  navigator: { onLine: boolean; storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } }
}
const scope = self as unknown as Scope

export type ImageSyncState = 'idle' | 'working' | 'paused-offline' | 'storage-full' | 'complete'
export type ImageProgress = {
  state: ImageSyncState
  thumbs: { ready: number; total: number }
  details: { ready: number; total: number }
  /** Cloud files that could not be fetched this pass (retried on the next pass). */
  failed: number
  /** Files of not-yet-uploaded products that exist nowhere on this device. */
  lost: number
  migrating: boolean
  lastError?: string
}

type Outcome = 'ok' | 'retry' | 'offline' | 'failed' | 'lost' | 'full'

const MAX_ACTIVE = 4
const MAX_ATTEMPTS = 4
const FETCH_TIMEOUT_MS = 60_000
const NETWORK_ERRORS_BEFORE_HOLD = 6

let dir: FileSystemDirectoryHandle | null = null
let legacyDir: FileSystemDirectoryHandle | null | undefined
const memory = new Map<string, Uint8Array>() // only used when the browser has no private file system (tests, private mode)
let present: Set<string> | null = null
let wanted = new Map<string, WantedImage>()
const extras = new Map<string, WantedImage>() // requested by name (PDF, viewer) and not (yet) in the wanted list
let queue: WantedImage[] = [], cursor = 0
const priority: string[] = []
const inflight = new Set<string>()
const waiters = new Map<string, ((ok: boolean) => void)[]>()
const attempts = new Map<string, number>()
const failed = new Set<string>(), lost = new Set<string>()
const deferred: { item: WantedImage; at: number }[] = []
const held: WantedImage[] = [] // waiting for the network to come back; costs no attempt
/** Files just written from this device's own photos, and when. They are safe from clean-up until a sync lists them
 *  as wanted, or for a couple of minutes — so a catalogue list computed a moment too early can never delete them. */
const protectedNames = new Map<string, number>()
const PROTECT_MS = 120_000
const isProtected = (name: string) => { const at = protectedNames.get(name); return at !== undefined && Date.now() - at < PROTECT_MS }
let active = 0, networkErrors = 0, holdUntil = 0, holdMs = 20_000, storageFull = false, lastError: string | undefined
let state: ImageSyncState = 'idle', timer: ReturnType<typeof setTimeout> | null = null
/** Worker-side canvas (iPadOS 16.4+). Probed once; when it is missing the page does the resize instead. */
let useOffscreen = false
let lastFailureReset = 0
const resizeJobs = new Map<number, (bytes: Uint8Array | null) => void>()
let resizeSeq = 0

const ready = (async () => {
  try {
    const getDirectory = scope.navigator.storage?.getDirectory
    if (typeof getDirectory !== 'function') return
    const root = await getDirectory.call(scope.navigator.storage)
    dir = await root.getDirectoryHandle(IMAGE_DIR, { create: true })
  } catch { dir = null }
  try {
    if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
      const canvas = new OffscreenCanvas(2, 2), ctx = canvas.getContext('2d')
      if (ctx) { ctx.fillRect(0, 0, 2, 2); useOffscreen = (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).size > 0 }
    }
  } catch { useOffscreen = false }
})()

// ---------- file system ----------

async function listPresent(): Promise<Set<string>> {
  const names = new Set<string>()
  if (!dir) { for (const name of memory.keys()) names.add(name); return names }
  // @ts-expect-error keys() async iteration is missing from older TS DOM libs
  for await (const name of dir.keys()) names.add(name as string)
  return names
}

/** Test hook: pretend the device runs out of space after this many writes (-1 = never). */
let failWritesAfter = -1, writeCount = 0

async function writeFile(name: string, bytes: Uint8Array) {
  if (failWritesAfter >= 0 && writeCount++ >= failWritesAfter) throw new DOMException('Device storage is full.', 'QuotaExceededError')
  if (!dir) { memory.set(name, bytes); return }
  const handle = await dir.getFileHandle(name, { create: true }) as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncHandle>; createWritable?: () => Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }> }
  if (typeof handle.createSyncAccessHandle === 'function') {
    const access = await handle.createSyncAccessHandle()
    try {
      access.truncate(0)
      let offset = 0
      while (offset < bytes.length) {
        const written = access.write(bytes.subarray(offset), { at: offset })
        if (!written) throw new DOMException('Device storage is full.', 'QuotaExceededError')
        offset += written
      }
      access.flush()
    } finally { access.close() }
    return
  }
  if (typeof handle.createWritable === 'function') { const writer = await handle.createWritable(); await writer.write(bytes as unknown as Uint8Array<ArrayBuffer>); await writer.close(); return }
  throw new Error('This browser cannot write image files.')
}

async function readFile(name: string): Promise<Uint8Array | null> {
  if (!dir) return memory.get(name) ?? null
  try { const file = await (await dir.getFileHandle(name)).getFile(); return new Uint8Array(await file.arrayBuffer()) } catch { return null }
}

async function removeFile(name: string) {
  present?.delete(name); protectedNames.delete(name)
  if (!dir) { memory.delete(name); return }
  try { await dir.removeEntry(name) } catch { /* already gone */ }
}

let legacyOpening: Promise<FileSystemDirectoryHandle | null> | null = null
/** The pre-migration folder, or null when this device never had one. Opened once; concurrent callers share the result. */
function openLegacy(): Promise<FileSystemDirectoryHandle | null> {
  if (legacyDir !== undefined) return Promise.resolve(legacyDir)
  legacyOpening ??= (async () => {
    let folder: FileSystemDirectoryHandle | null = null
    try {
      const getDirectory = scope.navigator.storage?.getDirectory
      if (typeof getDirectory === 'function') folder = await (await getDirectory.call(scope.navigator.storage)).getDirectoryHandle(LEGACY_IMAGE_DIR, { create: false })
    } catch { folder = null }
    legacyDir = folder; legacyOpening = null
    return folder
  })()
  return legacyOpening
}

/** Old store: a text file containing `data:image/jpeg;base64,...`. */
async function readLegacy(name: string): Promise<Uint8Array | null> {
  const folder = await openLegacy()
  if (!folder) return null
  try {
    const text = await (await (await folder.getFileHandle(name)).getFile()).text()
    const comma = text.indexOf(',')
    if (!text.startsWith('data:') || comma < 0) return null
    const binary = atob(text.slice(comma + 1)), bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.length ? bytes : null
  } catch { return null }
}

/** Removes old-format files that are no longer needed; keeps the ones whose new copy does not exist yet. */
async function cleanLegacy() {
  const folder = await openLegacy()
  if (!folder || !present || wanted.size === 0) return
  const needed = new Set<string>()
  for (const item of wanted.values()) if (!present.has(item.name)) needed.add(item.legacy)
  try {
    if (needed.size === 0) {
      const root = await scope.navigator.storage!.getDirectory!.call(scope.navigator.storage)
      await root.removeEntry(LEGACY_IMAGE_DIR, { recursive: true })
      legacyDir = null
      return
    }
    const names: string[] = []
    // @ts-expect-error keys() async iteration
    for await (const name of folder.keys()) names.push(name as string)
    for (const name of names) if (!needed.has(name)) await folder.removeEntry(name).catch(() => {})
  } catch { /* try again on the next pass */ }
}

// ---------- image work ----------

async function sha256(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))
  let hex = ''
  for (const b of digest) hex += b.toString(16).padStart(2, '0')
  return hex
}

async function matches(bytes: Uint8Array, item: WantedImage) {
  if (!bytes.length) return false
  if (item.sizeBytes && item.sizeBytes > 0 && bytes.length !== item.sizeBytes) return false
  if (item.checksum && /^[a-f0-9]{64}$/i.test(item.checksum)) return (await sha256(bytes)) === item.checksum.toLowerCase()
  return true
}

async function makeThumb(bytes: Uint8Array): Promise<Uint8Array> {
  if (useOffscreen) {
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as ArrayBuffer]))
    try {
      const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(bitmap.width, bitmap.height))
      const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Image could not be resized.')
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h)
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap, 0, 0, w, h)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY })
      return new Uint8Array(await blob.arrayBuffer())
    } finally { bitmap.close() }
  }
  const jobId = ++resizeSeq
  const result = await new Promise<Uint8Array | null>(resolve => {
    resizeJobs.set(jobId, resolve)
    const copy = bytes.slice()
    scope.postMessage({ event: 'need-resize', jobId, bytes: copy.buffer, maxSide: THUMB_MAX_SIDE, quality: THUMB_QUALITY }, [copy.buffer])
    setTimeout(() => { if (resizeJobs.delete(jobId)) resolve(null) }, 30_000)
  })
  if (!result) throw new Error('Image could not be decoded.')
  return result
}

async function download(item: WantedImage, attempt: number): Promise<Uint8Array | Outcome> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(item.url!, { cache: attempt > 0 ? 'reload' : 'default', signal: controller.signal })
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after'))
      holdUntil = Math.max(holdUntil, Date.now() + (retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : 2000 * 2 ** attempt))
      lastError = `Cloud is busy (${response.status}); slowing down.`
      return 'retry'
    }
    if (!response.ok) { lastError = `Cloud image unavailable (${response.status}).`; return 'failed' }
    const bytes = new Uint8Array(await response.arrayBuffer())
    networkErrors = 0; holdMs = 20_000
    if (!(await matches(bytes, item))) { lastError = 'A downloaded image failed its integrity check; retrying.'; return 'retry' }
    return bytes
  } catch {
    networkErrors++
    if (!scope.navigator.onLine || networkErrors >= NETWORK_ERRORS_BEFORE_HOLD) {
      holdUntil = Date.now() + holdMs; holdMs = Math.min(holdMs * 2, 60_000)
      return 'offline'
    }
    return 'retry'
  } finally { clearTimeout(timeout) }
}

async function produce(item: WantedImage): Promise<Outcome> {
  try {
    let bytes: Uint8Array | null = null
    if (item.localSource && present!.has(item.localSource)) bytes = await readFile(item.localSource)
    if (!bytes) { const old = await readLegacy(item.legacy); if (old && await matches(old, item)) bytes = old }
    if (!bytes) {
      if (!item.url) return 'lost'
      if (!scope.navigator.onLine || Date.now() < holdUntil) return 'offline'
      const result = await download(item, attempts.get(item.name) || 0)
      if (typeof result === 'string') return result
      bytes = result
    }
    let output = bytes
    if (item.rep === 'thumb') {
      try { output = await makeThumb(bytes) } catch { lastError = 'An image could not be decoded.'; return item.url ? 'retry' : 'lost' }
    }
    await writeFile(item.name, output)
    present!.add(item.name)
    return 'ok'
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'full'
    lastError = error instanceof Error ? error.message : 'Image write failed.'
    return 'retry'
  }
}

// ---------- scheduler ----------

const lookup = (name: string) => wanted.get(name) ?? extras.get(name)

function next(): WantedImage | null {
  while (priority.length) {
    const item = lookup(priority.shift()!)
    if (item && !present!.has(item.name) && !inflight.has(item.name)) return item
  }
  while (cursor < queue.length) {
    const item = lookup(queue[cursor++].name)
    if (!item || present!.has(item.name) || inflight.has(item.name) || failed.has(item.name) || lost.has(item.name)) continue
    return item
  }
  return null
}

function finish(name: string, ok: boolean) {
  const list = waiters.get(name)
  if (list) { waiters.delete(name); for (const resolve of list) resolve(ok) }
  extras.delete(name)
  if (ok) announce(name)
}

async function run(item: WantedImage) {
  inflight.add(item.name)
  const outcome = await produce(item)
  inflight.delete(item.name)
  if (outcome === 'ok') { attempts.delete(item.name); lastError = undefined }
  else if (outcome === 'offline') held.push(item)
  else if (outcome === 'retry') {
    const n = (attempts.get(item.name) || 0) + 1
    attempts.set(item.name, n)
    if (n >= MAX_ATTEMPTS) failed.add(item.name)
    else deferred.push({ item, at: Date.now() + 1000 * 3 ** (n - 1) })
  } else if (outcome === 'failed') failed.add(item.name)
  else if (outcome === 'lost') lost.add(item.name)
  else if (outcome === 'full') { storageFull = true; lastError = 'This device is out of storage space.' }
  finish(item.name, outcome === 'ok')
  // Nothing more can be written: release anyone waiting on a specific photo instead of leaving them hanging.
  if (storageFull) for (const name of [...waiters.keys()]) finish(name, false)
}

function pump() {
  if (!present) return
  if (!storageFull) {
    while (active < MAX_ACTIVE) {
      const item = next()
      if (!item) break
      active++
      void run(item).finally(() => { active--; pump() })
    }
  }
  if (active === 0) settle()
  else setState('working')
}

function settle() {
  if (timer) { clearTimeout(timer); timer = null }
  const now = Date.now()
  // Bring back anything whose wait is over.
  const due = deferred.filter(d => d.at <= now)
  if (due.length) { for (const d of due) { deferred.splice(deferred.indexOf(d), 1); queue.push(d.item) } return pump() }
  if (held.length && scope.navigator.onLine && now >= holdUntil) { queue.push(...held.splice(0)); return pump() }
  const waits = [...deferred.map(d => d.at), ...(held.length ? [Math.max(holdUntil, now + 5000)] : [])]
  if (waits.length && !storageFull) timer = setTimeout(pump, Math.max(250, Math.min(...waits) - now))
  if (storageFull) setState('storage-full')
  else if (held.length) setState('paused-offline')
  else if (deferred.length) setState('working')
  else setState(wanted.size ? 'complete' : 'idle')
  if (wanted.size > 0 && (state === 'complete' || state === 'paused-offline')) void cleanLegacy()
}

let progressTimer: ReturnType<typeof setTimeout> | null = null, readyTimer: ReturnType<typeof setTimeout> | null = null
const readyNames: string[] = []

function progress(): ImageProgress {
  const out: ImageProgress = { state, thumbs: { ready: 0, total: 0 }, details: { ready: 0, total: 0 }, failed: 0, lost: 0, migrating: Boolean(legacyDir), lastError }
  for (const name of wanted.keys()) {
    const bucket = isThumbName(name) ? out.thumbs : isDetailName(name) ? out.details : null
    if (!bucket) continue
    bucket.total++
    if (present?.has(name)) bucket.ready++
  }
  for (const name of failed) if (wanted.has(name)) out.failed++
  for (const name of lost) if (wanted.has(name)) out.lost++
  return out
}

function emitProgress(now = false) {
  if (now) { if (progressTimer) { clearTimeout(progressTimer); progressTimer = null } scope.postMessage({ event: 'progress', progress: progress() }); return }
  if (progressTimer) return
  progressTimer = setTimeout(() => { progressTimer = null; scope.postMessage({ event: 'progress', progress: progress() }) }, 400)
}

function setState(nextState: ImageSyncState) {
  const changed = nextState !== state
  state = nextState
  emitProgress(changed)
}

function announce(name: string) {
  readyNames.push(name)
  emitProgress()
  if (readyTimer) return
  readyTimer = setTimeout(() => { readyTimer = null; scope.postMessage({ event: 'ready', names: readyNames.splice(0) }) }, 80)
}

const ORDER: Record<WantedImage['rep'], number> = { grid: 0, thumb: 1, detail: 2 }

/** Full check for "Check & Repair": a file cut short by an interrupted write is removed so it gets fetched again. */
async function removeDamaged(list: WantedImage[]) {
  if (!dir || !present) return
  for (const item of list) {
    if (!present.has(item.name) || inflight.has(item.name)) continue
    try {
      const file = await (await dir.getFileHandle(item.name)).getFile()
      let ok = file.size > 0
      if (ok && item.rep === 'thumb') { const tail = new Uint8Array(await file.slice(-2).arrayBuffer()); ok = file.size > 100 && tail[0] === 0xff && tail[1] === 0xd9 }
      else if (ok && item.rep === 'detail' && item.sizeBytes) ok = file.size === item.sizeBytes
      if (!ok) await removeFile(item.name)
    } catch { present.delete(item.name) }
  }
}

let rescanRequested = false

async function applyWanted(list: WantedImage[], rescan: boolean) {
  if (rescanRequested) { rescan = true; rescanRequested = false }
  if (rescan || !present) present = await listPresent()
  if (rescan) await removeDamaged(list)
  const nextWanted = new Map<string, WantedImage>()
  for (const item of list) nextWanted.set(item.name, item)
  wanted = nextWanted
  for (const name of nextWanted.keys()) protectedNames.delete(name)
  // Old pictures of replaced/deleted products. Skipped when the list is empty so a failed load can never wipe the folder.
  if (nextWanted.size > 0) {
    for (const name of [...present]) {
      if (nextWanted.has(name) || isProtected(name) || inflight.has(name) || extras.has(name)) continue
      await removeFile(name)
    }
  }
  if (rescan || Date.now() - lastFailureReset > 60_000) { failed.clear(); lost.clear(); attempts.clear(); lastFailureReset = Date.now(); storageFull = false }
  requeueMissing()
  emitProgress(true)
}

/** Everything needed to show the catalogue first (upload sources, then thumbnails), high-res afterwards. */
function requeueMissing() {
  if (!present) return
  deferred.length = 0; held.length = 0
  queue = [...wanted.values()].filter(item => !present!.has(item.name)).sort((a, b) => ORDER[a.rep] - ORDER[b.rep])
  cursor = 0
  pump()
}

scope.addEventListener('online', () => { holdUntil = 0; holdMs = 20_000; networkErrors = 0; failed.clear(); attempts.clear(); requeueMissing() })

scope.addEventListener('message', async (event: MessageEvent) => {
  const message = event.data as { id?: number; op: string } & Record<string, unknown>
  const reply = (payload: Record<string, unknown> = {}, transfer: Transferable[] = []) => scope.postMessage({ id: message.id, ...payload }, transfer)
  try {
    await ready
    if (message.op === 'resized') { const resolve = resizeJobs.get(message.jobId as number); resizeJobs.delete(message.jobId as number); resolve?.(message.bytes ? new Uint8Array(message.bytes as ArrayBuffer) : null); return }
    if (!present) present = await listPresent()
    switch (message.op) {
      case 'init':
        if (message.forceMainResize) useOffscreen = false
        if (typeof message.failWritesAfter === 'number') failWritesAfter = message.failWritesAfter
        return reply({ opfs: Boolean(dir) })
      case 'put': {
        for (const file of message.files as { name: string; bytes: ArrayBuffer }[]) { protectedNames.set(file.name, Date.now()); await writeFile(file.name, new Uint8Array(file.bytes)); present.add(file.name); announce(file.name) }
        return reply()
      }
      case 'thumb': {
        const name = message.name as string
        protectedNames.set(name, Date.now())
        await writeFile(name, await makeThumb(new Uint8Array(message.bytes as ArrayBuffer)))
        present.add(name); announce(name)
        return reply()
      }
      case 'read': {
        const bytes = present.has(message.name as string) ? await readFile(message.name as string) : null
        if (!bytes) return reply({ bytes: null })
        const copy = bytes.slice()
        return reply({ bytes: copy.buffer }, [copy.buffer])
      }
      case 'delete': for (const name of message.names as string[]) await removeFile(name); return reply()
      case 'delete-product': {
        const prefix = `${message.productId as string}.`
        for (const name of [...present]) if (name.startsWith(prefix) && productIdOfImage(name) === message.productId) await removeFile(name)
        return reply()
      }
      case 'rename': {
        for (const [from, to] of message.pairs as [string, string][]) {
          if (from === to || !present.has(from) || present.has(to)) continue
          const bytes = await readFile(from)
          if (!bytes) continue
          protectedNames.set(to, Date.now()); await writeFile(to, bytes); present.add(to); await removeFile(from); announce(to)
        }
        return reply()
      }
      case 'sync': await applyWanted(message.wanted as WantedImage[], false); return reply()
      case 'rescan':
        // Asked before the catalogue list arrived: remember it and do the full check with the next list.
        if (wanted.size === 0) rescanRequested = true
        else await applyWanted([...wanted.values()], true)
        return reply()
      case 'ensure': {
        const items = message.items as WantedImage[]
        const results = await Promise.all(items.map(item => {
          if (present!.has(item.name)) return true
          if (storageFull) return false
          if (!wanted.has(item.name)) extras.set(item.name, item)
          failed.delete(item.name); lost.delete(item.name); attempts.delete(item.name)
          return new Promise<boolean>(resolve => {
            waiters.set(item.name, [...(waiters.get(item.name) || []), resolve])
            if (!inflight.has(item.name)) priority.unshift(item.name)
            pump()
          })
        }))
        return reply({ results })
      }
      case 'prioritize': {
        for (const name of message.names as string[]) if (!present.has(name) && !inflight.has(name) && wanted.has(name)) priority.push(name)
        pump()
        return reply()
      }
      case 'invalidate': {
        const name = message.name as string
        await removeFile(name)
        if (wanted.has(name)) { failed.delete(name); priority.unshift(name); pump() }
        emitProgress()
        return reply()
      }
      case 'wipe': {
        wanted = new Map(); queue = []; cursor = 0; priority.length = 0; deferred.length = 0; held.length = 0; extras.clear(); protectedNames.clear(); memory.clear()
        try {
          const root = await scope.navigator.storage!.getDirectory!.call(scope.navigator.storage)
          await root.removeEntry(IMAGE_DIR, { recursive: true }).catch(() => {})
          await root.removeEntry(LEGACY_IMAGE_DIR, { recursive: true }).catch(() => {})
          dir = await root.getDirectoryHandle(IMAGE_DIR, { create: true })
        } catch { /* no private file system */ }
        legacyDir = undefined; present = new Set(); setState('idle')
        return reply()
      }
      default: throw new Error(`Unknown image operation: ${message.op}`)
    }
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : 'Image operation failed.' })
  }
})
