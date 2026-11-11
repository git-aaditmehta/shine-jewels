// Bench-only: writes a synthetic catalogue straight into the app's real local store (SQLite WASM + OPFS image files),
// in exactly the shape the app persists after a successful initialDownload (gridImage = local OPFS path).
import { LocalSqlite } from '../src/local-sqlite'

type SeedOptions = { count: number; cloudFraction: number; variants?: number }
type SeedResult = { count: number; cloudProducts: number; gridBytesAvg: number; seedMs: number; sampleJpegBase64: string }
declare global { interface Window { seed: (o: SeedOptions) => Promise<SeedResult> } }

const R2 = 'https://pub-ddd4389cc31a46b6b365e21911f96e1f.r2.dev'

function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

const toDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(blob) })

/** A photo-like jewellery image: white backdrop, gold necklace arc with beads, a paper tag and sensor grain,
 *  encoded exactly like the app's pipeline (max side 600px, JPEG q0.85) so file sizes are realistic. */
async function jewelleryJpeg(seed: number, w: number, h: number, quality: number) {
  const rand = rng(seed), c = new OffscreenCanvas(w, h), g = c.getContext('2d')!
  const bg = g.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#f4f4f1'); bg.addColorStop(1, '#dfe1e0'); g.fillStyle = bg; g.fillRect(0, 0, w, h)
  g.fillStyle = '#fbfbf8'; g.fillRect(w * 0.42, h * 0.04, w * 0.16, h * 0.1)
  g.fillStyle = '#555'; g.font = `${Math.round(h * 0.025)}px sans-serif`; g.fillText(`SW-${seed}`, w * 0.44, h * 0.09)
  const cx = w / 2, cy = h * (0.2 + rand() * 0.1), rx = w * (0.32 + rand() * 0.1), ry = h * (0.45 + rand() * 0.2)
  for (let i = 0; i <= 90; i++) {
    const a = Math.PI * (0.1 + 0.8 * (i / 90)), x = cx - Math.cos(a) * rx, y = cy + Math.sin(a) * ry, r = 4 + rand() * 9
    const gold = g.createRadialGradient(x - r / 3, y - r / 3, 1, x, y, r); gold.addColorStop(0, '#fff3c4'); gold.addColorStop(0.45, '#d9a640'); gold.addColorStop(1, '#7a5313')
    g.fillStyle = gold; g.beginPath(); g.ellipse(x, y, r, r * (0.7 + rand() * 0.6), a, 0, Math.PI * 2); g.fill()
  }
  const img = g.getImageData(0, 0, w, h), d = img.data
  for (let i = 0; i < d.length; i += 4) { const n = (rand() - 0.5) * 18; d[i] += n; d[i + 1] += n; d[i + 2] += n }
  g.putImageData(img, 0, 0)
  return c.convertToBlob({ type: 'image/jpeg', quality })
}

window.seed = async ({ count, cloudFraction, variants = 48 }) => {
  const started = performance.now(), status = document.getElementById('status')!
  // Start from an empty device: Playwright WebKit can keep OPFS between profiles, so wipe it before the database opens.
  const root = await navigator.storage.getDirectory()
  // @ts-expect-error keys() async iteration is not in older TS DOM libs
  for await (const name of root.keys()) await root.removeEntry(name, { recursive: true }).catch(() => {})
  const db = new LocalSqlite(), rand = rng(42)
  // Same table the app's storage layer creates on boot.
  await db.execute('CREATE TABLE IF NOT EXISTS local_entities(entity_type TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(entity_type,id))')
  await db.setCheckpoint('storage_schema_version', '5')
  await db.setCheckpoint('sync_checkpoint', '1')

  // Mix of landscape (short necklaces) and portrait (long necklaces) like the real catalogue.
  const grids: string[] = []; let gridBytes = 0
  for (let v = 0; v < variants; v++) {
    const blob = await jewelleryJpeg(1000 + v, v % 3 === 0 ? 340 : 600, v % 3 === 0 ? 600 : 470, 0.85)
    gridBytes += blob.size; grids.push(await toDataUrl(blob))
  }
  const tinyDetail = await toDataUrl(await jewelleryJpeg(7, 64, 64, 0.5))
  const sampleJpegBase64 = grids[1].split(',')[1]

  await db.execute('BEGIN')
  const cats = ['Necklace', 'Long Necklace', 'Bangles', 'Earrings']
  for (let c = 0; c < cats.length; c++) {
    await db.execute('INSERT OR REPLACE INTO local_entities(entity_type,id,payload) VALUES(?,?,?)', ['category', `cat-${c}`, JSON.stringify({ id: `cat-${c}`, name: cats[c], active: true })])
    for (let s = 0; s < 3; s++) await db.execute('INSERT OR REPLACE INTO local_entities(entity_type,id,payload) VALUES(?,?,?)', ['subcategory', `sub-${c}-${s}`, JSON.stringify({ id: `sub-${c}-${s}`, categoryId: `cat-${c}`, name: `${cats[c]} ${s + 1}`, active: true })])
  }
  let cloudProducts = 0
  for (let i = 0; i < count; i++) {
    const id = `bench-${String(i).padStart(5, '0')}`, c = i % cats.length, cloud = rand() < cloudFraction
    const gridKey = `bench/products/${id}/v1/grid`, detailKey = `bench/products/${id}/v1/detail`
    if (cloud) cloudProducts++
    else await db.putImage(`${id}-grid-v1`, grids[i % variants])
    await db.putImage(`${id}-detail-v1`, tinyDetail) // "already downloaded" so sync's offline-detail loop sees it as cached
    const product = {
      id, designCode: `SW ${i + 1}`, categoryId: `cat-${c}`, subcategoryId: `sub-${c}-${i % 3}`, weightMg: 5000 + Math.round(rand() * 55000),
      gridImage: cloud ? `${R2}/${gridKey}` : `${id}-grid-v1`, detailImage: `${id}-detail-v1`, imageVersion: 1, syncState: 'SYNCED', deleted: false,
      gridImageKey: gridKey, detailImageKey: detailKey, gridImageSizeBytes: 60000, detailImageSizeBytes: 400000
    }
    await db.execute('INSERT OR REPLACE INTO local_entities(entity_type,id,payload) VALUES(?,?,?)', ['product', id, JSON.stringify(product)])
    if (i % 500 === 0) status.textContent = `Seeding ${i}/${count}`
  }
  await db.execute('COMMIT')
  status.textContent = 'done'
  return { count, cloudProducts, gridBytesAvg: Math.round(gridBytes / variants), seedMs: Math.round(performance.now() - started), sampleJpegBase64 }
}
