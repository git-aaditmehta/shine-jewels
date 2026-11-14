#!/usr/bin/env node
// Functional checks for the on-device photo store and background downloader (run after `npm run bench:build`):
//   node bench/verify-images.mjs [--only migrate,download,...]
// Every scenario uses a fresh WebKit profile (the iPad's engine) and the local mock cloud — nothing touches Cloudflare.
import { webkit } from 'playwright'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { startMockCloud } from './mock-cloud.mjs'

const PORT = 4322, ORIGIN = `http://localhost:${PORT}`
const only = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1].split(',') : null })()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const sha = buf => createHash('sha256').update(buf).digest('hex')
const checks = []
const check = (name, ok, info = '') => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

const preview = spawn('npx', ['vite', 'preview', '--config', 'bench/vite.bench.config.ts', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
for (let i = 0; i < 60; i++) { try { if ((await fetch(ORIGIN)).ok) break } catch { /* wait */ } await sleep(250) }
const cloud = await startMockCloud()
const OUT = 'bench/results/phase3'
await mkdir(OUT, { recursive: true })

async function device(init = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'shine-img-'))
  const context = await webkit.launchPersistentContext(dir, { headless: true, viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' })
  await context.addInitScript(flags => {
    localStorage.setItem('shine-jewels.session', JSON.stringify({ userId: 'u', displayName: 'Bench', role: 'ADMIN', organizationId: 'bench', offlineAuthorizationExpiresAt: '2099-01-01T00:00:00.000Z', token: 't' }))
    sessionStorage.setItem('shine-jewels.session', localStorage.getItem('shine-jewels.session'))
    for (const [k, v] of Object.entries(flags)) if (localStorage.getItem(`${k}.off`) !== '1') localStorage.setItem(k, v)
  }, init)
  return { context, close: async () => { await context.close(); await rm(dir, { recursive: true, force: true }) } }
}

async function seed(context, options) {
  const page = await context.newPage()
  await page.goto(`${ORIGIN}/bench/seed.html`); await page.waitForFunction(() => typeof window.seed === 'function')
  const seeded = await page.evaluate(o => window.seed(o), options)
  await page.close(); await sleep(400)
  cloud.setVariants(seeded); cloud.mode = 'ok'; cloud.r2Gets = 0; cloud.r2Served = 0; cloud.uploads.clear(); cloud.corrupted.clear(); cloud.apiCalls.length = 0
  seeded.gridHashes = new Set(seeded.gridVariants.map(b => sha(Buffer.from(b, 'base64')))); seeded.detailHashes = new Set(seeded.detailVariants.map(b => sha(Buffer.from(b, 'base64'))))
  return seeded
}

async function openApp(context, count) {
  const page = await context.newPage()
  page.on('pageerror', e => console.log('  [page error]', e.message))
  await page.goto(ORIGIN)
  if (count) await page.waitForFunction(n => document.body.innerText.includes(`${n} designs`), count, { timeout: 60000 })
  return page
}

const progress = page => page.evaluate(() => window.__sjImages.progress())
const waitFor = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout, polling: 200 }).then(() => true).catch(() => false)
const complete = (page, timeout) => waitFor(page, () => { const p = window.__sjImages?.progress(); return p && p.state === 'complete' && p.thumbs.total > 0 && p.thumbs.ready === p.thumbs.total && p.details.ready === p.details.total }, null, timeout)

/** Everything in the private file system: new store (name, size, sha256 for details / JPEG-complete flag for thumbs) and old store count. */
const disk = page => page.evaluate(async () => {
  const root = await navigator.storage.getDirectory(), out = { files: [], legacy: null }
  try {
    const dir = await root.getDirectoryHandle('sj-images-v2')
    for await (const [name, handle] of dir.entries()) {
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer()), kind = name.split('.')[1]
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
      out.files.push({ name, id: name.split('.')[0], kind, size: bytes.length, hash, jpegComplete: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9 })
    }
  } catch { /* no folder */ }
  try { const dir = await root.getDirectoryHandle('shine-jewels-images'); out.legacy = 0; for await (const _ of dir.keys()) out.legacy++ } catch { /* removed */ }
  return out
})

const tiles = page => page.evaluate(async () => {
  const imgs = [...document.querySelectorAll('.grid .product img')]
  await Promise.all(imgs.map(i => i.src && !i.complete ? new Promise(r => { i.onload = i.onerror = r }) : null))
  return imgs.map(i => ({ shown: Boolean(i.src) && i.complete && i.naturalWidth > 0, w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 5) }))
})

/** Overwrite / cut / delete files in the image folder from a throwaway worker (WebKit only allows sync file writes in workers). */
const tamper = (page, actions) => page.evaluate(actions => new Promise((resolve, reject) => {
  const source = `onmessage = async e => { try { const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('sj-images-v2')
    for (const a of e.data) {
      if (a.op === 'delete') { await dir.removeEntry(a.name); continue }
      const h = await (await dir.getFileHandle(a.name)).createSyncAccessHandle()
      if (a.op === 'truncate') h.truncate(Math.floor(h.getSize() / 2)); if (a.op === 'empty') h.truncate(0)
      h.flush(); h.close()
    } postMessage('ok') } catch (err) { postMessage('error: ' + err.message) } }`
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
  worker.onmessage = e => { worker.terminate(); e.data === 'ok' ? resolve(true) : reject(new Error(e.data)) }
  worker.postMessage(actions)
}), actions)

const scenarios = {
  // ---- Update installs on a device holding the old text-format photos, including designs never uploaded. ----
  async migrate() {
    const d = await device(), COUNT = 150, PENDING = 3
    try {
      const seeded = await seed(d.context, { count: COUNT, cloudFraction: 0.2, pending: PENDING, variants: 12 })
      cloud.mode = 'drop' // no cloud at all while the app starts
      const page = await openApp(d.context, COUNT)
      const localOnly = COUNT - seeded.cloudProducts
      const migrated = await waitFor(page, n => { const p = window.__sjImages.progress(); return p.thumbs.ready === n && p.details.ready === n }, localOnly, 60000)
      let p = await progress(page), files = await disk(page)
      check('migrate: every photo already on the device is converted with no internet', migrated, `${p.thumbs.ready}/${p.thumbs.total} thumbs, ${p.details.ready}/${p.details.total} high-res, state ${p.state}`)
      check('migrate: offline state is reported, cloud photos wait', p.state === 'paused-offline' && cloud.r2Served === 0, `state ${p.state}`)
      const pendingIds = Array.from({ length: PENDING }, (_, i) => `bench-${String(COUNT - 1 - i).padStart(5, '0')}`)
      const pendingKinds = pendingIds.map(id => files.files.filter(f => f.id === id).map(f => f.kind).sort().join('+'))
      check('migrate: not-yet-uploaded designs keep thumbnail + upload source + high-res', pendingKinds.every(k => k === 'detail+grid+t360q78'), pendingKinds.join(' | '))
      const details = files.files.filter(f => f.kind === 'detail')
      check('migrate: converted high-res files are byte-identical to the originals', details.length === localOnly && details.every(f => seeded.detailHashes.has(f.hash)), `${details.length} files`)
      const thumbs = files.files.filter(f => f.kind === 't360q78')
      check('migrate: thumbnails are complete JPEGs of the chosen size', thumbs.length === localOnly && thumbs.every(f => f.jpegComplete && f.size > 2000 && f.size < 60000), `avg ${Math.round(thumbs.reduce((t, f) => t + f.size, 0) / thumbs.length / 1024)} KB`)
      const shown = await tiles(page)
      check('migrate: tiles show 360px thumbnails from this device', shown.filter(t => t.shown).length >= shown.length * 0.6 && shown.filter(t => t.shown).every(t => Math.max(t.w, t.h) === 360 && t.src === 'blob:'), `${shown.filter(t => t.shown).length}/${shown.length} shown`)
      await page.screenshot({ path: `${OUT}/migrate-offline.png` })

      cloud.mode = 'ok'; cloud.r2Gets = 0
      await page.evaluate(() => window.dispatchEvent(new Event('online'))) // the app's own "back online" sync
      const done = await complete(page, 90000)
      p = await progress(page); files = await disk(page)
      check('migrate: back online, the rest downloads and everything completes', done, JSON.stringify(p))
      check('migrate: cloud was asked only for photos that were not on the device', cloud.r2Gets === seeded.cloudProducts * 2, `${cloud.r2Gets} requests for ${seeded.cloudProducts} cloud designs`)
      await waitFor(page, () => /Sync complete|sync/i.test(document.body.innerText), null, 15000); await sleep(1500)
      const uploaded = pendingIds.every(id => cloud.uploads.has(`bench/products/${id}/v1/grid`) && cloud.uploads.has(`bench/products/${id}/v1/detail`))
      const uploadedIntact = pendingIds.every(id => seeded.detailHashes.has(sha(cloud.uploads.get(`bench/products/${id}/v1/detail`) || Buffer.alloc(0))) && seeded.gridHashes.has(sha(cloud.uploads.get(`bench/products/${id}/v1/grid`) || Buffer.alloc(0))))
      check('migrate: not-yet-uploaded designs upload after the update, byte-identical', uploaded && uploadedIntact, `${cloud.uploads.size} files uploaded`)
      await sleep(1500); files = await disk(page)
      check('migrate: old text-format folder is removed once nothing needs it', files.legacy === null, `legacy entries: ${files.legacy}`)
      const after = await disk(page)
      check('migrate: after upload each design holds exactly thumbnail + high-res (upload source cleaned up)', after.files.length === COUNT * 2 && after.files.every(f => f.kind !== 'grid'), `${after.files.length} files`)
      await page.reload(); await page.waitForFunction(n => document.body.innerText.includes(`${n} designs`), COUNT)
      await sleep(1200)
      const again = await tiles(page)
      check('migrate: after restart every visible tile shows instantly from disk', again.length > 0 && again.every(t => t.shown), `${again.filter(t => t.shown).length}/${again.length}`)
      await page.screenshot({ path: `${OUT}/migrate-done.png` })
    } finally { await d.close() }
  },

  // ---- Fresh download after a wipe, with the network misbehaving in every way we could think of. ----
  async download() {
    const d = await device(), COUNT = 240
    try {
      const seeded = await seed(d.context, { count: COUNT, cloudFraction: 1, images: 'none', variants: 12 })
      cloud.latencyMs = 25
      let page = await openApp(d.context, COUNT)
      const ready = n => waitFor(page, n => window.__sjImages.progress().thumbs.ready >= n, n, 30000)
      check('download: catalogue opens immediately, photos arrive in the background', await ready(20), JSON.stringify((await progress(page)).thumbs))
      const first = await progress(page)
      check('download: thumbnails are fetched before high-res', first.details.ready === 0 && first.thumbs.ready > 0, `thumbs ${first.thumbs.ready}, high-res ${first.details.ready}`)

      // 1. Wi-Fi drops.
      cloud.mode = 'drop'; await sleep(3000)
      const off = await progress(page); await sleep(2000); const off2 = await progress(page)
      check('download: internet lost → pauses (no errors, nothing lost)', off2.state === 'paused-offline' && off2.thumbs.ready === off.thumbs.ready && off2.failed === 0, `state ${off2.state}, ${off2.thumbs.ready} thumbs`)
      cloud.mode = 'ok'
      check('download: internet back → resumes by itself', await waitFor(page, n => window.__sjImages.progress().thumbs.ready >= n, off2.thumbs.ready + 20, 70000), JSON.stringify((await progress(page)).thumbs))

      // 2. Cloud says "too many requests".
      cloud.mode = 'busy'; await sleep(2500); const busy = await progress(page)
      cloud.mode = 'ok'
      check('download: cloud rate-limit (429) → waits and retries, nothing marked failed', await ready(busy.thumbs.ready + 20) && (await progress(page)).failed === 0, `at 429: ${busy.thumbs.ready}, state ${busy.state}`)

      // 3. App closed half way, then opened again.
      const before = await progress(page), servedBefore = cloud.r2Served
      await page.close(); await sleep(500)
      page = await openApp(d.context, COUNT)
      await sleep(600)
      const resumed = await progress(page)
      check('download: app closed half way → continues from where it stopped', resumed.thumbs.ready >= before.thumbs.ready && resumed.thumbs.ready < COUNT + 1, `before ${before.thumbs.ready}, after reopen ${resumed.thumbs.ready}`)

      // 4. Damaged downloads: the first copy of every remaining file arrives corrupted.
      cloud.mode = 'corrupt-once'
      const done = await complete(page, 120000)
      const p = await progress(page), files = await disk(page)
      check('download: finishes with every photo present', done && p.failed === 0, JSON.stringify(p))
      const details = files.files.filter(f => f.kind === 'detail'), thumbs = files.files.filter(f => f.kind === 't360q78')
      check('download: damaged downloads were rejected — every stored high-res matches its checksum', cloud.corrupted.size > 0 && details.length === COUNT && details.every(f => seeded.detailHashes.has(f.hash)), `${cloud.corrupted.size} corrupted responses rejected`)
      check('download: every thumbnail is a complete JPEG', thumbs.length === COUNT && thumbs.every(f => f.jpegComplete))
      check('download: no file was downloaded twice without reason', cloud.r2Served - servedBefore <= (COUNT * 2 - before.thumbs.ready - before.details.ready) + cloud.corrupted.size + 8, `${cloud.r2Served} served in total for ${COUNT * 2} files (+${cloud.corrupted.size} rejected)`)
      cloud.mode = 'ok'; cloud.latencyMs = 0

      // 5. Browsing must not touch the network once photos are on the device.
      const gets = cloud.r2Gets
      for (let i = 0; i < 12; i++) { await page.evaluate(() => window.scrollBy(0, 900)); await sleep(120) }
      await page.locator('.grid .product .image-button').first().click(); await sleep(500)
      for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); await sleep(250) }
      const viewer = await page.evaluate(() => { const i = document.querySelector('.fullscreen-jewelry-img'); return { src: i?.src.slice(0, 5), w: i?.naturalWidth, h: i?.naturalHeight } })
      check('viewer: shows the high-res file from this device', viewer.src === 'blob:' && Math.max(viewer.w, viewer.h) >= 1400, JSON.stringify(viewer))
      await page.screenshot({ path: `${OUT}/viewer.png` })
      await page.keyboard.press('Escape'); await sleep(300)
      check('browsing: zero cloud image requests while scrolling and viewing', cloud.r2Gets === gets, `${cloud.r2Gets - gets} requests`)

      // 6. Files damaged or deleted behind the app's back.
      const victimThumb = thumbs[0].name, victimDetail = details[1].name, deletedDetail = details[2].name
      await tamper(page, [{ op: 'truncate', name: victimThumb }, { op: 'truncate', name: victimDetail }, { op: 'delete', name: deletedDetail }])
      await page.reload(); await page.waitForFunction(n => document.body.innerText.includes(`${n} designs`), COUNT)
      await page.getByRole('button', { name: 'storage', exact: true }).click()
      await page.getByRole('button', { name: /Check & Repair/ }).click()
      let fixed, byName, repaired = false
      for (let i = 0; i < 20 && !repaired; i++) {
        await sleep(1000); fixed = await disk(page); byName = Object.fromEntries(fixed.files.map(f => [f.name, f]))
        repaired = Boolean(byName[victimThumb]?.jpegComplete && seeded.detailHashes.has(byName[victimDetail]?.hash) && seeded.detailHashes.has(byName[deletedDetail]?.hash))
      }
      check('repair: cut-off and deleted files are found and downloaded again', repaired, `thumb ok ${Boolean(byName[victimThumb]?.jpegComplete)}, cut high-res ok ${seeded.detailHashes.has(byName[victimDetail]?.hash)}, deleted high-res ok ${seeded.detailHashes.has(byName[deletedDetail]?.hash)}`)
      await page.screenshot({ path: `${OUT}/storage-screen.png` })

      // 7. iOS evicts the app's storage (photo folder gone).
      await page.evaluate(async () => { await (await navigator.storage.getDirectory()).removeEntry('sj-images-v2', { recursive: true }) })
      await page.reload(); await page.waitForFunction(n => document.body.innerText.includes(`${n} designs`), COUNT)
      const restored = await complete(page, 120000)
      check('eviction: photo folder wiped by the system → everything downloads again by itself', restored && (await disk(page)).files.length === COUNT * 2)
    } finally { cloud.latencyMs = 0; cloud.mode = 'ok'; await d.close() }
  },

  // ---- Everyday work: add a design, replace its photo, make PDFs, delete it. Uses two of the real sample photos. ----
  async product() {
    const d = await device(), COUNT = 60, SAMPLES = process.env.SJ_SAMPLES
    try {
      await seed(d.context, { count: COUNT, cloudFraction: 0, variants: 12 })
      const page = await openApp(d.context, COUNT)
      await complete(page, 60000)
      const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
      const newFiles = async known => (await disk(page)).files.filter(f => !known.has(f.name))
      const known = new Set((await disk(page)).files.map(f => f.name))

      // Add a design with no internet.
      cloud.mode = 'drop'
      await nav('products')
      await page.getByRole('button', { name: '+ Add New Design' }).click()
      const form = page.locator('form.entry-form')
      await form.locator('input[name=code]').fill('NEW-1')
      await form.locator('select').nth(0).selectOption({ index: 1 }); await form.locator('select').nth(1).selectOption({ index: 1 })
      await form.locator('input[name=weight]').fill('12.345')
      await form.locator('input[name=image]').setInputFiles(`${SAMPLES}/s6.jpg`)
      await form.getByRole('button', { name: 'Stage design' }).click()
      await waitFor(page, () => /NEW-1 saved locally/.test(document.body.innerText), null, 20000)
      await sleep(1500)
      let mine = await newFiles(known)
      check('add design (no internet): thumbnail, upload source and high-res are stored as files', mine.map(f => f.kind).sort().join('+') === 'detail+grid+t360q78' && mine.every(f => f.jpegComplete), mine.map(f => `${f.kind} ${Math.round(f.size / 1024)}KB`).join(', '))
      const localDetail = mine.find(f => f.kind === 'detail'), localGrid = mine.find(f => f.kind === 'grid'), localThumb = mine.find(f => f.kind === 't360q78')
      await nav('catalogue')
      await page.locator('input[placeholder*="SJ-1001"]').first().fill('NEW-1'); await sleep(700)
      let tile = await tiles(page)
      check('add design: appears in the catalogue straight away with its photo', tile.length === 1 && tile[0].shown && Math.max(tile[0].w, tile[0].h) === 360, JSON.stringify(tile))
      await page.screenshot({ path: `${OUT}/new-design.png` })

      // Internet returns: it uploads, and the device keeps using the files it already has.
      cloud.mode = 'ok'; cloud.r2Gets = 0
      await page.evaluate(() => window.dispatchEvent(new Event('online')))
      const uploadedKey = () => [...cloud.uploads.keys()].find(k => k.endsWith('/v1/detail'))
      for (let i = 0; i < 40 && !uploadedKey(); i++) await sleep(500)
      await sleep(2500)
      const up = uploadedKey()
      check('upload: the stored files are sent to the cloud byte-for-byte', Boolean(up) && sha(cloud.uploads.get(up)) === localDetail.hash && sha(cloud.uploads.get(up.replace('/detail', '/grid'))) === localGrid.hash, up || 'nothing uploaded')
      mine = await newFiles(known)
      check('upload: afterwards the device keeps thumbnail + high-res, drops the upload source, downloads nothing', mine.map(f => f.kind).sort().join('+') === 'detail+t360q78' && mine.some(f => f.name === localThumb.name) && cloud.r2Gets === 0, `${mine.map(f => f.kind).join('+')}, ${cloud.r2Gets} downloads`)

      // Replace the photo.
      await nav('products')
      await page.locator('.catalogue-admin-tab').first().click()
      await page.getByPlaceholder('Search active designs by code...').fill('NEW-1'); await sleep(400)
      await page.getByRole('button', { name: /Edit/ }).first().click()
      const preview = await waitFor(page, () => { const i = document.querySelector('.edit-image-preview'); return i && i.complete && i.naturalWidth >= 1500 }, null, 10000)
      check('edit screen: shows the current high-res photo from this device', preview)
      await page.locator('.product-modal-col input[type=file]').setInputFiles(`${SAMPLES}/s8.jpg`)
      await page.getByRole('button', { name: 'Save Changes' }).click()
      for (let i = 0; i < 40 && ![...cloud.uploads.keys()].some(k => k.endsWith('/v2/detail')); i++) await sleep(500)
      await sleep(2500)
      mine = await newFiles(known)
      check('replace photo: new thumbnail + high-res stored, old picture removed', mine.filter(f => f.kind !== 'grid').length === 2 && mine.every(f => f.name !== localThumb.name && f.name !== localDetail.name), mine.map(f => f.name.split('.').slice(1).join('.')).join(', '))
      await nav('catalogue'); await sleep(800)
      tile = await tiles(page)
      check('replace photo: catalogue shows the new picture (portrait instead of landscape)', tile.length === 1 && tile[0].shown && tile[0].h === 360 && tile[0].w < 360, JSON.stringify(tile))

      // Order PDFs (client + manufacturer) and the history re-print.
      await page.locator('input[placeholder*="SJ-1001"]').first().fill(''); await sleep(600)
      const selects = page.locator('.grid .product .select')
      for (let i = 0; i < 3; i++) await selects.nth(i).click()
      await page.locator('.order-tray select').first().selectOption({ index: 1 })
      const pdfInfo = async () => {
        await page.waitForSelector('.pdf-preview-embed', { timeout: 60000 })
        return page.evaluate(async () => { const bytes = new Uint8Array(await (await fetch(document.querySelector('.pdf-preview-embed').src)).arrayBuffer()); const text = new TextDecoder('latin1').decode(bytes); return { kb: Math.round(bytes.length / 1024), images: (text.match(/\/Subtype\s*\/Image/g) || []).length, pages: (text.match(/\/Type\s*\/Page\b/g) || []).length } })
      }
      const closePdf = async () => { await page.getByRole('button', { name: 'Close PDF preview' }).click(); await sleep(400) }
      await page.locator('.order-tray .primary').click()
      const orderPdf = await pdfInfo()
      check('order PDF: generated with a photo for each of the 3 designs', orderPdf.images >= 3 && orderPdf.kb > 30, JSON.stringify(orderPdf))
      await page.screenshot({ path: `${OUT}/order-pdf.png` })
      await closePdf()
      await nav('history'); await sleep(800)
      await page.getByRole('button', { name: 'Preview & Export PDF' }).first().click()
      const historyPdf = await pdfInfo()
      check('history: re-opening an old order PDF still has its photos', historyPdf.images >= 3, JSON.stringify(historyPdf))
      await closePdf()

      // Sales demo PDF uses the high-res files.
      await nav('catalogue'); await sleep(400)
      await page.locator('.sales-demo-toggle-btn').click(); await sleep(300)
      const demoButtons = page.locator('.grid .product .select')
      await demoButtons.nth(0).click(); await demoButtons.nth(1).click()
      await page.locator('.sales-demo-btn-primary').click()
      const demoPdf = await pdfInfo()
      check('sales demo PDF: built from the high-res photos on this device', demoPdf.images >= 2 && demoPdf.kb > 250, JSON.stringify(demoPdf))
      await page.screenshot({ path: `${OUT}/demo-pdf.png` })
      await closePdf()
      check('PDFs: no cloud image requests were needed', cloud.r2Gets === 0, `${cloud.r2Gets} requests`)

      // Delete.
      await nav('products')
      await page.locator('.catalogue-admin-tab').first().click()
      await page.getByPlaceholder('Search active designs by code...').fill('NEW-1'); await sleep(400)
      await page.getByRole('button', { name: /Delete/ }).first().click()
      await page.locator('.danger-btn').click()
      await sleep(2500)
      mine = await newFiles(known)
      check('delete design: its photo files are removed from the device', mine.length === 0, `${mine.length} left`)
    } finally { cloud.mode = 'ok'; await d.close() }
  },

  // ---- Older iPadOS (no canvas inside workers): thumbnails are resized by the page instead. ----
  async fallback() {
    const d = await device({ 'sj.forceMainResize': '1' }), COUNT = 40
    try {
      await seed(d.context, { count: COUNT, cloudFraction: 1, images: 'none', variants: 8 })
      const page = await openApp(d.context, COUNT)
      const done = await complete(page, 60000), files = await disk(page), shown = await tiles(page)
      check('fallback: page-side resize produces the same 360px thumbnails', done && files.files.filter(f => f.kind === 't360q78').every(f => f.jpegComplete) && shown.every(t => t.shown && Math.max(t.w, t.h) === 360), `${shown.length} tiles`)
    } finally { await d.close() }
  },

  // ---- Device runs out of space part-way. ----
  async full() {
    const d = await device({ 'sj.debugFailWritesAfter': '30' }), COUNT = 60
    try {
      await seed(d.context, { count: COUNT, cloudFraction: 1, images: 'none', variants: 8 })
      const page = await openApp(d.context, COUNT)
      const stopped = await waitFor(page, () => window.__sjImages.progress().state === 'storage-full', null, 30000)
      const p = await progress(page)
      await page.getByRole('button', { name: 'storage', exact: true }).click(); await sleep(300)
      const message = await page.evaluate(() => document.querySelector('.image-sync-status')?.textContent || '')
      check('storage full: download stops cleanly and says why', stopped && p.thumbs.ready === 30 && /out of space/i.test(message), `${p.thumbs.ready} saved · "${message}"`)
      await page.screenshot({ path: `${OUT}/storage-full.png` })
      await page.evaluate(() => { localStorage.setItem('sj.debugFailWritesAfter.off', '1'); localStorage.removeItem('sj.debugFailWritesAfter') })
      await page.reload(); await page.waitForFunction(n => document.body.innerText.includes(`${n} designs`), COUNT)
      check('storage full: after space is freed it carries on and completes', await complete(page, 60000))
    } finally { await d.close() }
  },
}

try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue
    console.log(`\n== ${name} ==`)
    try { await run() } catch (error) { check(`${name}: scenario ran to the end`, false, error.message.split('\n')[0]) }
  }
} finally {
  preview.kill(); await cloud.close()
}
const failed = checks.filter(c => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
await writeFile(`${OUT}/verify-images.json`, JSON.stringify({ at: new Date().toISOString(), checks }, null, 2))
process.exit(failed.length ? 1 : 0)
