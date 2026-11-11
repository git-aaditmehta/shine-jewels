#!/usr/bin/env node
// Catalogue performance bench. Usage:
//   npm run bench -- --count 1296 --runs 3 --label baseline [--engine webkit|chromium] [--cpu 4] [--cloud 0.3] [--headed]
// Seeds a synthetic catalogue into the real local store, opens the production build at iPad Air landscape size,
// and measures load, memory, scroll smoothness and blank tiles. All cloud traffic is mocked (nothing leaves this Mac).
import { webkit, chromium } from 'playwright'
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]) : fallback }
const COUNT = Number(arg('count', 1296)), RUNS = Number(arg('runs', 3)), LABEL = String(arg('label', 'run')), ENGINE = String(arg('engine', 'webkit'))
const CPU = Number(arg('cpu', 1)), CLOUD = Number(arg('cloud', 0)), HEADED = Boolean(arg('headed', false)), PORT = 4319
const ORIGIN = `http://localhost:${PORT}`
const R2_LATENCY_MS = 400, R2_PARALLEL = 6 // measured r2.dev from Mumbai/Jio: ~416ms warm, HTTP/1.1 (=6 connections/host)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN }

async function startPreview() {
  const proc = spawn('npx', ['vite', 'preview', '--config', 'bench/vite.bench.config.ts', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) { try { if ((await fetch(ORIGIN)).ok) return proc } catch { /* not up yet */ } await sleep(250) }
  proc.kill(); throw new Error('vite preview did not start (did you run npm run bench:build?)')
}

// Resident memory (MB) of every browser process launched by Playwright — the closest Mac proxy for iPad tab memory.
async function browserRssMb() {
  const { stdout } = await run('ps', ['-A', '-o', 'rss=,command='], { maxBuffer: 1 << 24 })
  let kb = 0
  for (const line of stdout.split('\n')) if (line.includes('ms-playwright')) kb += Number(line.trim().split(/\s+/)[0]) || 0
  return kb / 1024
}

// In-page probe, cost independent of catalogue size: hit-tests a 60px lattice over the visible grid area.
const PROBE = `(() => {
  window.__probe = () => {
    const grid = document.querySelector('.grid'); if (!grid) return { visible: 0, incomplete: 0, coverage: 0 }
    const gr = grid.getBoundingClientRect(), top = Math.max(0, gr.top), bottom = Math.min(innerHeight, gr.bottom)
    const seen = new Map(); let points = 0, covered = 0
    for (let y = top + 15; y < bottom; y += 60) for (let x = gr.left + 15; x < gr.right; x += 60) {
      points++; const card = document.elementFromPoint(x, y)?.closest('.product'); if (!card) continue
      covered++; if (!seen.has(card)) { const img = card.querySelector('img'); seen.set(card, !img || !img.complete || img.naturalWidth === 0) }
    }
    let incomplete = 0; for (const v of seen.values()) if (v) incomplete++
    return { visible: seen.size, incomplete, coverage: points ? covered / points : 1 }
  }
})()`

// Frame loop: drives scrolling and records frame times + blank tiles per frame.
async function scrollTest(page, mode) {
  return page.evaluate(async ({ mode, count }) => {
    const frames = [], blanks = [], coverage = []; let last = performance.now(), start = last, reachedEnd = null, maxIncomplete = 0
    const lastCode = `SW ${count}`
    const lastVisible = () => {
      const strong = [...document.querySelectorAll('.grid .product strong')].find(s => s.textContent === lastCode); if (!strong) return false
      const card = strong.closest('.product'), r = card.getBoundingClientRect(), img = card.querySelector('img')
      return r.top < innerHeight && r.bottom > 0 && !!img?.complete && img.naturalWidth > 0
    }
    window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 300))
    await new Promise(resolve => {
      const tick = now => {
        frames.push(now - last); last = now
        const p = window.__probe(); blanks.push(p.incomplete); coverage.push(p.coverage); maxIncomplete = Math.max(maxIncomplete, p.incomplete)
        const elapsed = now - start
        // fling: a fast, continuous flick (3000 px/s) from top until the LAST product is on screen and loaded.
        if (mode === 'fling') { if (lastVisible() && p.incomplete === 0) { reachedEnd = elapsed; return resolve() } window.scrollBy(0, 3000 * (frames.at(-1) / 1000)); if (elapsed > 60000) return resolve() }
        // jump: one instant jump to the bottom of the page (like dragging the scroll indicator), then wait until every visible tile is filled.
        if (mode === 'jump') { if (frames.length === 1) window.scrollTo(0, document.documentElement.scrollHeight); else if (p.visible > 0 && p.incomplete === 0) { reachedEnd = elapsed; return resolve() } if (elapsed > 30000) return resolve() }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const ft = frames.slice(1)
    return { frames: ft.length, frameP50: ft.sort((a, b) => a - b)[Math.floor(ft.length / 2)], frameP95: ft[Math.floor(ft.length * 0.95)], frameMax: ft.at(-1),
      jankyPct: Math.round(100 * ft.filter(f => f > 50).length / Math.max(1, ft.length)), framesWithBlankTiles: blanks.filter(b => b > 0).length, maxBlankTiles: maxIncomplete,
      minCoverage: Math.min(...coverage), msToFinish: reachedEnd, atLastProduct: lastVisible(), domCards: document.querySelectorAll('.grid .product').length }
  }, { mode, count: COUNT })
}

async function oneRun(index, sampleJpeg) {
  const dir = await mkdtemp(join(tmpdir(), 'shine-bench-'))
  const engine = ENGINE === 'chromium' ? chromium : webkit
  const context = await engine.launchPersistentContext(dir, { headless: !HEADED, viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' })
  let r2Requests = 0, inflight = 0; const r2Queue = []
  await context.route(/\.workers\.dev\//, async route => {
    const path = new URL(route.request().url()).pathname, h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'content-type': 'application/json' }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const body = path.startsWith('/sync/bootstrap') ? { categories: [], subcategories: [], vendors: [], products: [], presentations: [], checkpoint: 1 }
      : (path.startsWith('/sync/changes') || ['/history', '/devices', '/staff'].includes(path)) ? [] : { ok: true }
    return route.fulfill({ status: 200, headers: h, body: JSON.stringify(body) })
  })
  // r2.dev simulated as measured: ~400ms per image, max 6 at a time (HTTP/1.1).
  await context.route(/r2\.dev\//, async route => {
    r2Requests++
    if (inflight >= R2_PARALLEL) await new Promise(r => r2Queue.push(r))
    inflight++; await sleep(R2_LATENCY_MS)
    try { await route.fulfill({ status: 200, headers: { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' }, body: sampleJpeg }) } catch { /* page gone */ }
    inflight--; r2Queue.shift()?.()
  })

  const stage = t => process.stderr.write(`  [run ${index + 1}] ${t}\n`)
  stage('seeding')
  const seedPage = await context.newPage()
  await seedPage.goto(`${ORIGIN}/bench/seed.html`)
  await seedPage.waitForFunction(() => typeof window.seed === 'function')
  const seeded = await seedPage.evaluate(o => window.seed(o), { count: COUNT, cloudFraction: CLOUD })
  await seedPage.close(); await sleep(800)
  const rssBeforeApp = await browserRssMb()

  await context.addInitScript(() => {
    localStorage.setItem('shine-jewels.session', JSON.stringify({ userId: 'bench-admin', displayName: 'Bench', role: 'ADMIN', organizationId: 'bench', offlineAuthorizationExpiresAt: '2099-01-01T00:00:00.000Z', token: 'bench-token' }))
  })
  await context.addInitScript(PROBE)

  let peakRss = 0, sampling = true
  const sampler = (async () => { while (sampling) { peakRss = Math.max(peakRss, await browserRssMb().catch(() => 0)); await sleep(300) } })()

  const page = await context.newPage()
  if (ENGINE === 'chromium' && CPU > 1) { const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }) }
  const r2BeforeLoad = r2Requests
  stage('loading app')
  await page.goto(ORIGIN, { waitUntil: 'commit' })
  const msCatalogueReady = await page.waitForFunction(n => document.body.innerText.includes(`${n} designs`) && performance.now(), COUNT, { timeout: 120000 }).then(h => h.jsonValue()).catch(async e => { console.error('PAGE TEXT:', (await page.evaluate(() => document.body.innerText)).slice(0, 300)); throw e })
  stage('catalogue ready')
  const msFirstImages = await page.waitForFunction(() => { const p = window.__probe(); return p.visible > 0 && p.incomplete === 0 && performance.now() }, null, { timeout: 120000, polling: 'raf' }).then(h => h.jsonValue()).catch(() => null)
  stage('first images shown')
  const msSyncDone = await page.waitForFunction(() => /Sync complete|Sync failed/.test(document.body.innerText) && performance.now(), null, { timeout: 60000 }).then(h => h.jsonValue()).catch(() => null)
  stage('sync done; scrolling')
  await sleep(1000)
  const rssSettled = await browserRssMb()
  const r2DuringLoad = r2Requests - r2BeforeLoad
  // Chromium only: trace the rendering pipeline during the fling. CPU throttling does not slow painting/raster,
  // so frame times alone cannot show CSS (blur/shadow) cost — summed paint+raster+composite time can.
  let render = null
  if (ENGINE === 'chromium') {
    const cdp = await context.newCDPSession(page), events = []
    cdp.on('Tracing.dataCollected', e => events.push(...e.value))
    const done = new Promise(r => cdp.once('Tracing.tracingComplete', r))
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'cc', 'blink'] } })
    var fling = await scrollTest(page, 'fling')
    await cdp.send('Tracing.end'); await done
    const sum = names => Math.round(events.filter(e => names.includes(e.name) && e.dur).reduce((t, e) => t + e.dur, 0) / 1000)
    render = { paintMs: sum(['Paint', 'PaintArtifactCompositor::Update']), rasterMs: sum(['RasterTask']), layoutStyleMs: sum(['Layout', 'UpdateLayoutTree']), compositeMs: sum(['Commit', 'CompositeLayers', 'UpdateLayer']) }
    render.totalMs = render.paintMs + render.rasterMs + render.layoutStyleMs + render.compositeMs
    render.perFrameMs = +(render.totalMs / Math.max(1, fling.frames)).toFixed(2)
  } else {
    var fling = await scrollTest(page, 'fling')
  }
  const jump = await scrollTest(page, 'jump')
  sampling = false; await sampler
  const r2Total = r2Requests - r2BeforeLoad
  await context.close(); await rm(dir, { recursive: true, force: true })
  return { index, seeded: { cloudProducts: seeded.cloudProducts, gridBytesAvg: seeded.gridBytesAvg, seedMs: seeded.seedMs }, msCatalogueReady: Math.round(msCatalogueReady), msFirstImages: msFirstImages && Math.round(msFirstImages),
    msSyncDone: msSyncDone && Math.round(msSyncDone), rssBeforeAppMb: Math.round(rssBeforeApp), appRssMb: Math.round(rssSettled - rssBeforeApp), rssSettledMb: Math.round(rssSettled), peakRssMb: Math.round(peakRss), r2DuringLoad, r2Total, fling, jump, render }
}

async function sampleJpegOnce() {
  // Grab one realistic JPEG for the r2.dev mock from a throwaway seed.
  const dir = await mkdtemp(join(tmpdir(), 'shine-bench-jpeg-'))
  const ctx = await webkit.launchPersistentContext(dir, { headless: true })
  const p = await ctx.newPage(); await p.goto(`${ORIGIN}/bench/seed.html`); await p.waitForFunction(() => typeof window.seed === 'function')
  const r = await p.evaluate(() => window.seed({ count: 1, cloudFraction: 0, variants: 2 }))
  await ctx.close(); await rm(dir, { recursive: true, force: true })
  return Buffer.from(r.sampleJpegBase64, 'base64')
}

const preview = await startPreview()
try {
  const jpeg = await sampleJpegOnce()
  const results = []
  for (let i = 0; i < RUNS; i++) { const r = await oneRun(i, jpeg); results.push(r); console.log(`run ${i + 1}/${RUNS}`, JSON.stringify(r)) }
  const m = f => median(results.map(f).filter(v => v !== null && v !== undefined))
  const summary = {
    label: LABEL, engine: ENGINE, cpuThrottle: CPU, count: COUNT, cloudFraction: CLOUD, runs: RUNS, at: new Date().toISOString(),
    msCatalogueReady: m(r => r.msCatalogueReady), msFirstImages: m(r => r.msFirstImages), msSyncDone: m(r => r.msSyncDone),
    appRssMb: m(r => r.appRssMb), rssSettledMb: m(r => r.rssSettledMb), peakRssMb: m(r => r.peakRssMb), r2DuringLoad: m(r => r.r2DuringLoad), r2Total: m(r => r.r2Total),
    fling: { msToReachLastProduct: m(r => r.fling.msToFinish), reachedLast: results.every(r => r.fling.atLastProduct), frames: m(r => r.fling.frames), frameP50: m(r => r.fling.frameP50), frameP95: m(r => r.fling.frameP95), jankyPct: m(r => r.fling.jankyPct),
      framesWithBlankTiles: m(r => r.fling.framesWithBlankTiles), maxBlankTiles: m(r => r.fling.maxBlankTiles), minCoverage: m(r => r.fling.minCoverage), domCardsAtEnd: m(r => r.fling.domCards) },
    render: results[0].render ? { perFrameMs: m(r => r.render.perFrameMs), totalMs: m(r => r.render.totalMs), rasterMs: m(r => r.render.rasterMs), paintMs: m(r => r.render.paintMs), layoutStyleMs: m(r => r.render.layoutStyleMs), compositeMs: m(r => r.render.compositeMs) } : null,
    jump: { msUntilScreenFilled: m(r => r.jump.msToFinish), framesWithBlankTiles: m(r => r.jump.framesWithBlankTiles), maxBlankTiles: m(r => r.jump.maxBlankTiles), domCards: m(r => r.jump.domCards) }
  }
  console.log('\nSUMMARY', JSON.stringify(summary, null, 2))
  await mkdir('bench/results', { recursive: true })
  await writeFile(`bench/results/${LABEL}-${ENGINE}${CPU > 1 ? `-cpu${CPU}` : ''}-${COUNT}${CLOUD ? `-cloud${CLOUD}` : ''}.json`, JSON.stringify({ summary, results }, null, 2))
} finally { preview.kill() }
