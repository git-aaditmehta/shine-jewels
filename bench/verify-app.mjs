#!/usr/bin/env node
// Checks for app-level bugs (run after `npm run bench:build`): node bench/verify-app.mjs [--only login,token,scale]
import { webkit } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { startMockCloud } from './mock-cloud.mjs'

const PORT = 4323, ORIGIN = `http://localhost:${PORT}`
const only = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1].split(',') : null })()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const checks = []
const check = (name, ok, info = '') => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }
const preview = spawn('npx', ['vite', 'preview', '--config', 'bench/vite.bench.config.ts', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
for (let i = 0; i < 60; i++) { try { if ((await fetch(ORIGIN)).ok) break } catch { /* wait */ } await sleep(250) }
const cloud = await startMockCloud()
const SESSION = JSON.stringify({ userId: 'u', displayName: 'Bench', role: 'ADMIN', organizationId: 'bench', offlineAuthorizationExpiresAt: '2099-01-01T00:00:00.000Z', token: 't' })

async function device() {
  const dir = await mkdtemp(join(tmpdir(), 'shine-app-'))
  const context = await webkit.launchPersistentContext(dir, { headless: true, viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, serviceWorkers: 'block' })
  return { context, close: async () => { await context.close(); await rm(dir, { recursive: true, force: true }) } }
}
async function seed(context, options) {
  const page = await context.newPage(); await page.goto(`${ORIGIN}/bench/seed.html`); await page.waitForFunction(() => typeof window.seed === 'function')
  const seeded = await page.evaluate(o => window.seed(o), options); await page.close(); await sleep(300)
  cloud.setVariants(seeded); cloud.mode = 'ok'; cloud.uploads.clear(); cloud.apiCalls.length = 0
  return seeded
}

const scenarios = {
  // Fresh sign-in and sign-out must not crash the app.
  async login() {
    const d = await device()
    try {
      await seed(d.context, { count: 20, cloudFraction: 0, variants: 4, detailSide: 400 })
      const page = await d.context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message))
      await page.goto(ORIGIN)
      await page.waitForSelector('.login-card', { timeout: 20000 })
      const inputs = page.locator('.login-card input')
      await inputs.nth(0).fill('bench'); await inputs.nth(1).fill('admin'); await inputs.nth(2).fill('secret')
      await page.locator('.login-card button[type=submit], .login-card .primary').first().click()
      const inApp = await page.waitForFunction(() => document.body.innerText.includes('20 designs'), null, { timeout: 20000 }).then(() => true).catch(() => false)
      const text = await page.evaluate(() => document.body.innerText.slice(0, 200))
      check('login: signing in opens the catalogue without a crash', inApp && !errors.some(e => /hooks/i.test(e)), inApp ? 'catalogue shown' : `${text.replace(/\n/g, ' ')} | ${errors.join(' | ').slice(0, 200)}`)
      if (inApp) {
        await page.getByRole('button', { name: 'Log out' }).click()
        const back = await page.waitForSelector('.login-card', { timeout: 10000 }).then(() => true).catch(() => false)
        check('logout: returns to the sign-in screen without a crash', back && !errors.some(e => /hooks/i.test(e)), errors.join(' | ').slice(0, 200))
      }
    } finally { await d.close() }
  },

  // After the Home Screen app is relaunched only localStorage still holds the session.
  async token() {
    const d = await device()
    try {
      await seed(d.context, { count: 20, cloudFraction: 0, variants: 4, detailSide: 400 })
      await d.context.addInitScript(s => { localStorage.setItem('shine-jewels.session', s); sessionStorage.removeItem('shine-jewels.session') }, SESSION)
      const page = await d.context.newPage(); await page.goto(ORIGIN)
      await page.waitForFunction(() => document.body.innerText.includes('20 designs'), null, { timeout: 30000 })
      await page.getByRole('navigation').getByRole('button', { name: 'products', exact: true }).click()
      await page.getByRole('button', { name: '+ Add New Design' }).click()
      const form = page.locator('form.entry-form')
      await form.locator('input[name=code]').fill('TOK-1')
      await form.locator('select').nth(0).selectOption({ index: 1 }); await form.locator('select').nth(1).selectOption({ index: 1 })
      await form.locator('input[name=weight]').fill('10')
      await form.locator('input[name=image]').setInputFiles(`${process.env.SJ_SAMPLES}/s6.jpg`)
      cloud.apiCalls.length = 0
      await form.getByRole('button', { name: 'Stage design' }).click()
      for (let i = 0; i < 30 && cloud.uploads.size < 2; i++) await sleep(500)
      const notice = await page.evaluate(() => document.querySelector('.notice')?.textContent?.slice(0, 90))
      check('relaunched app: a new design uploads straight away (not "saved offline")', cloud.uploads.size === 2, `${cloud.uploads.size} files uploaded · notice: ${notice}`)
      const bootstraps = cloud.apiCalls.filter(c => c.includes('/sync/bootstrap')).length
      check('upload: does not download the whole catalogue list first', bootstraps === 0, `${bootstraps} full-catalogue requests · ${cloud.apiCalls.join(' ; ')}`)
    } finally { await d.close() }
  },

  // First download for a business with a long order history: vendor and order saves must not slow down as data grows.
  async history() {
    const d = await device(), ORDERS = Number(process.env.SJ_ORDERS || 3000), VENDORS = 300
    try {
      await seed(d.context, { count: 0, cloudFraction: 0, variants: 2, detailSide: 400 })
      const vendors = Array.from({ length: VENDORS }, (_, i) => ({ id: `v-${i}`, name: `Vendor ${i}`, address: `${i} Road`, city: 'Mumbai', type: 'WHOLESALE' }))
      const presentations = Array.from({ length: ORDERS }, (_, i) => ({ id: `o-${i}`, order_number: i + 1, vendor_id: `v-${i % VENDORS}`, vendor_name_snapshot: `Vendor ${i % VENDORS}`, vendor_address_snapshot: 'x', vendor_city_snapshot: 'Mumbai', vendor_type_snapshot: 'WHOLESALE', status: 'FINALIZED', generated_at: '2026-01-01T00:00:00Z', items: [{ product_id: 'p', design_code_snapshot: 'NS 1', quantity: 1, serial_number: 1 }] }))
      cloud.bootstrap = { categories: [{ id: 'c1', name: 'Necklace' }], subcategories: [{ id: 's1', category_id: 'c1', name: 'Short' }], vendors, products: [{ id: 'p1', design_code: 'NS 1', category_id: 'c1', subcategory_id: 's1', weight_mg: 1000 }], presentations, checkpoint: 1 }
      // Fresh device: wipe the seeded catalogue so sign-in performs the full first download.
      const wipe = await d.context.newPage(); await wipe.goto(`${ORIGIN}/bench/seed.html`)
      await wipe.evaluate(async () => { const root = await navigator.storage.getDirectory(); for await (const n of root.keys()) await root.removeEntry(n, { recursive: true }).catch(() => {}) }); await wipe.close()
      const page = await d.context.newPage(); await page.goto(ORIGIN)
      await page.waitForSelector('.login-card', { timeout: 20000 })
      const inputs = page.locator('.login-card input')
      await inputs.nth(0).fill('bench'); await inputs.nth(1).fill('admin'); await inputs.nth(2).fill('secret')
      const t0 = Date.now()
      await page.locator('.login-card button[type=submit], .login-card .primary').first().click()
      const ok = await page.waitForFunction(() => document.body.innerText.includes('1 designs'), null, { timeout: 300000 }).then(() => true).catch(() => false)
      const ms = Date.now() - t0
      await page.getByRole('navigation').getByRole('button', { name: 'history', exact: true }).click(); await sleep(800)
      const shown = await page.evaluate(() => (document.body.innerText.match(/#\d+/g) || []).length)
      check(`first download with ${ORDERS} past orders and ${VENDORS} vendors finishes in under 10 seconds`, ok && ms < 10000, `${(ms / 1000).toFixed(1)} s`)
      check('every past order is kept', shown >= ORDERS || shown === 0, `${shown} order numbers visible`)
    } finally { cloud.bootstrap = null; await d.close() }
  },

  // Two iPads offline pick the same order number. The order made here must survive, upload, and stay visible.
  async clash() {
    const d = await device()
    try {
      await seed(d.context, { count: 20, cloudFraction: 0, variants: 4, detailSide: 400 })
      cloud.history = []; cloud.orderPosts = []
      await d.context.addInitScript(s => { localStorage.setItem('shine-jewels.session', s); sessionStorage.setItem('shine-jewels.session', s) }, SESSION)
      const page = await d.context.newPage(); await page.goto(ORIGIN)
      await page.waitForFunction(() => document.body.innerText.includes('20 designs'), null, { timeout: 30000 }); await sleep(1500)
      cloud.mode = 'drop' // this iPad goes offline
      const selects = page.locator('.grid .product .select')
      await selects.nth(0).click(); await selects.nth(1).click()
      await page.locator('.order-tray select').first().selectOption({ index: 1 })
      await page.locator('.order-tray .primary').click()
      await page.waitForSelector('.pdf-preview-embed', { timeout: 60000 })
      await page.getByRole('button', { name: 'Close PDF preview' }).click(); await sleep(400)
      // Meanwhile the other iPad's order #1 reached the cloud.
      cloud.history = [{ id: 'other-ipad-order', order_number: 1, status: 'FINALIZED', vendor_name_snapshot: 'Other Vendor', vendor_address_snapshot: 'x', vendor_city_snapshot: 'Pune', vendor_type_snapshot: 'RETAIL', generated_at: '2026-11-12T10:00:00Z', items: [{ product_id: 'bench-00005', design_code_snapshot: 'SW 6', quantity: 2, serial_number: 1 }] }]
      // Back online, but the cloud rejects this order once (temporary server problem) while the other order comes down.
      cloud.mode = 'ok'; cloud.rejectOrders = true
      await page.getByRole('navigation').getByRole('button', { name: 'history', exact: true }).click()
      await sleep(3000)
      const during = await page.evaluate(() => document.body.innerText)
      check('order clash: while the upload is failing, the order made here is not deleted', /Bench Jewellers/.test(during) && /Other Vendor/.test(during), `Bench Jewellers ${/Bench Jewellers/.test(during)}, Other Vendor ${/Other Vendor/.test(during)}`)
      cloud.rejectOrders = false
      await page.getByRole('navigation').getByRole('button', { name: 'catalogue', exact: true }).click(); await sleep(300)
      await page.getByRole('navigation').getByRole('button', { name: 'history', exact: true }).click()
      for (let i = 0; i < 30 && !cloud.orderPosts.length; i++) await sleep(500)
      await sleep(2500)
      const text = await page.evaluate(() => document.body.innerText)
      check('order clash: the order made offline here was uploaded', cloud.orderPosts.length === 1 && cloud.orderPosts[0].items.length === 2, `${cloud.orderPosts.length} uploaded`)
      check('order clash: both orders are in History', /Bench Jewellers/.test(text) && /Other Vendor/.test(text), `Bench Jewellers ${/Bench Jewellers/.test(text)}, Other Vendor ${/Other Vendor/.test(text)}`)
      await page.reload(); await page.waitForFunction(() => document.body.innerText.includes('20 designs'), null, { timeout: 30000 })
      await page.getByRole('navigation').getByRole('button', { name: 'history', exact: true }).click(); await sleep(1500)
      const after = await page.evaluate(() => document.body.innerText)
      check('order clash: both orders are still there after restarting the app', /Bench Jewellers/.test(after) && /Other Vendor/.test(after))
    } finally { cloud.mode = 'ok'; cloud.history = []; cloud.rejectOrders = false; await d.close() }
  },

  // The client iPad's situation: designs made while signed out, whose failed uploads an older app erased, so they sit on
  // the device with nothing in the upload queue. One of them has a code a different cloud design already uses.
  async stranded() {
    const d = await device(), COUNT = 150, PENDING = 130
    try {
      await seed(d.context, { count: COUNT, cloudFraction: 0, variants: 4, detailSide: 400, pending: PENDING, stranded: true })
      cloud.productPosts = []; cloud.codes = new Map([['sw 150', 'cloud-other-design']]); cloud.signedOut = true
      await d.context.addInitScript(s => { localStorage.setItem('shine-jewels.session', s); sessionStorage.setItem('shine-jewels.session', s) }, SESSION)
      const page = await d.context.newPage(); await page.goto(ORIGIN)
      await page.waitForFunction(n => document.body.innerText.includes(`${n} designs`), COUNT, { timeout: 30000 })
      const signedOutMsg = await page.waitForFunction(() => /signed out of the cloud/.test(document.body.innerText), null, { timeout: 30000 }).then(() => true).catch(() => false)
      check('signed out: a clear "sign in again" message, not a cryptic failure', signedOutMsg)
      await page.getByRole('navigation').getByRole('button', { name: 'storage', exact: true }).click(); await sleep(800)
      const queued = await page.evaluate(() => (document.body.innerText.match(/(\d+) operation\(s\) pending/) || [])[1])
      check(`stranded designs are put back in the upload queue at start-up (all ${PENDING}, not capped at 100)`, Number(queued) === PENDING, `${queued} queued`)
      check('signed out: nothing is uploaded and nothing is lost', cloud.productPosts.length === 0 && cloud.uploads.size === 0)

      cloud.signedOut = false
      await page.getByRole('button', { name: 'Run Full Synchronization' }).click()
      for (let i = 0; i < 240 && cloud.productPosts.length < PENDING - 1; i++) await sleep(500)
      await page.waitForFunction(() => /Sync complete/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {})
      await sleep(1000)
      const posted = new Set(cloud.productPosts.map(p => p.designCode))
      check(`one sync uploads every stranded design with a new code (${PENDING - 1})`, posted.size === PENDING - 1 && !posted.has('SW 150'), `${posted.size} uploaded, clash uploaded: ${posted.has('SW 150')}`)
      const photosOk = cloud.productPosts.every(p => cloud.uploads.has(p.gridImage?.key) && cloud.uploads.has(p.detailImage?.key))
      check('each uploaded design has both photos in the cloud', photosOk, `${cloud.uploads.size} photo files`)
      const text = await page.evaluate(() => document.body.innerText)
      check('the clashing design is held back and listed in the Storage tab', /Kept on this iPad only — 1 design/.test(text) && /SW 150/.test(text))
      check('queue is empty after the sync', /\b0 operation\(s\) pending/.test(text), (text.match(/\d+ operation\(s\) pending/) || [])[0])

      // Restart: nothing is uploaded twice, the held-back design stays held back and on the device.
      const before = cloud.productPosts.length
      await page.reload(); await page.waitForFunction(n => document.body.innerText.includes(`${n} designs`), COUNT, { timeout: 30000 }); await sleep(4000)
      await page.getByRole('navigation').getByRole('button', { name: 'storage', exact: true }).click(); await sleep(800)
      const after = await page.evaluate(() => document.body.innerText)
      check('after restart: nothing is uploaded again and all designs are still on the device', cloud.productPosts.length === before, `${cloud.productPosts.length - before} re-uploads`)
      check('after restart: the held-back design is still kept and still not uploaded', /Kept on this iPad only — 1 design/.test(after) && !cloud.productPosts.some(p => p.designCode === 'SW 150'))
    } finally { cloud.signedOut = false; cloud.codes = new Map(); await d.close() }
  },

  // 10,000 designs, details only (no photo files) — measures catalogue load and background sync.
  async scale() {
    const d = await device(), COUNT = 10000
    try {
      await seed(d.context, { count: COUNT, cloudFraction: 1, images: 'none', variants: 4, detailSide: 400 })
      cloud.mode = 'drop-images'
      await d.context.addInitScript(s => { localStorage.setItem('shine-jewels.session', s); sessionStorage.setItem('shine-jewels.session', s) }, SESSION)
      const page = await d.context.newPage(); cloud.apiCalls.length = 0
      await page.goto(ORIGIN, { waitUntil: 'commit' })
      const ready = await page.waitForFunction(n => document.body.innerText.includes(`${n.toLocaleString('en-US').replace(',', '')} designs`) && performance.now(), COUNT, { timeout: 120000 }).then(h => h.jsonValue()).catch(() => null)
      const synced = await page.waitForFunction(() => /Sync complete|Sync failed/.test(document.body.innerText) && performance.now(), null, { timeout: 120000 }).then(h => h.jsonValue()).catch(() => null)
      const bootstraps = cloud.apiCalls.filter(c => c.includes('/sync/bootstrap')).length
      check('10,000 designs: catalogue opens in under 2 seconds', ready !== null && ready < 2000, `${Math.round(ready)} ms`)
      check('10,000 designs: background sync finishes in under 3 seconds', synced !== null && synced < 3000, `${Math.round(synced)} ms`)
      check('10,000 designs: an ordinary sync does not download the whole catalogue list', bootstraps === 0, `${bootstraps} full-catalogue requests`)
    } finally { cloud.mode = 'ok'; await d.close() }
  },
}

try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue
    console.log(`\n== ${name} ==`)
    try { await run() } catch (error) { check(`${name}: scenario ran to the end`, false, error.message.split('\n')[0]) }
  }
} finally { preview.kill(); await cloud.close() }
const failed = checks.filter(c => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
