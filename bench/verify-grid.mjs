#!/usr/bin/env node
// Functional checks for the virtualized catalogue grid (run after `npm run bench:build`):
//   node bench/verify-grid.mjs
// Seeds 1,296 products, then checks: DOM card count stays bounded, filter → scroll resets to top, search works,
// viewer next/prev beyond the rendered window scrolls the grid, hidden tab → shown re-measures, rotation re-lays out,
// select/deselect survives scrolling, and the last product is reachable.
import { webkit } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const PORT = 4321, ORIGIN = `http://localhost:${PORT}`, COUNT = 1296
const sleep = ms => new Promise(r => setTimeout(r, ms))
const checks = []
const check = (name, ok, info = '') => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }

const preview = spawn('npx', ['vite', 'preview', '--config', 'bench/vite.bench.config.ts', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
for (let i = 0; i < 60; i++) { try { if ((await fetch(ORIGIN)).ok) break } catch { /* wait */ } await sleep(250) }

const dir = await mkdtemp(join(tmpdir(), 'shine-verify-'))
const context = await webkit.launchPersistentContext(dir, { headless: true, viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' })
try {
  await context.route(/\.workers\.dev\//, route => route.fulfill({ status: route.request().method() === 'OPTIONS' ? 204 : 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'content-type': 'application/json' }, body: route.request().method() === 'OPTIONS' ? '' : JSON.stringify(/sync\/changes|history|devices|staff/.test(route.request().url()) ? [] : { categories: [], subcategories: [], vendors: [], products: [], presentations: [], checkpoint: 1, ok: true }) }))
  const seed = await context.newPage(); await seed.goto(`${ORIGIN}/bench/seed.html`); await seed.waitForFunction(() => typeof window.seed === 'function')
  await seed.evaluate(o => window.seed(o), { count: COUNT, cloudFraction: 0 }); await seed.close(); await sleep(500)
  await context.addInitScript(() => localStorage.setItem('shine-jewels.session', JSON.stringify({ userId: 'u', displayName: 'Bench', role: 'ADMIN', organizationId: 'bench', offlineAuthorizationExpiresAt: '2099-01-01T00:00:00.000Z', token: 't' })))
  const page = await context.newPage()
  await page.goto(ORIGIN)
  await page.waitForFunction(n => document.body.innerText.includes(`${n} designs`), COUNT, { timeout: 120000 })
  await sleep(800)

  const cards = () => page.evaluate(() => document.querySelectorAll('.grid .product').length)
  const codes = () => page.evaluate(() => [...document.querySelectorAll('.grid .product strong')].map(s => s.textContent))
  const cols = () => page.evaluate(() => getComputedStyle(document.querySelector('.virtual-grid-row')).gridTemplateColumns.split(' ').length)

  const initial = await cards()
  check('bounded DOM at top', initial > 0 && initial < 120, `${initial} cards for ${COUNT} products`)
  check('first card is SW 1', (await codes())[0] === 'SW 1')

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await sleep(600)
  const atBottom = await codes()
  check('bottom shows last product', atBottom.at(-1) === `SW ${COUNT}`, atBottom.at(-1))
  check('bounded DOM at bottom', (await cards()) < 120, `${await cards()} cards`)

  // Selection state survives scrolling away and back.
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(400)
  await page.click('.grid .product:nth-child(3) .select'); await sleep(100)
  await page.evaluate(() => window.scrollTo(0, 20000)); await sleep(500)
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(500)
  check('selection persists across scroll', await page.evaluate(() => document.querySelector('.grid .product:nth-child(3) .select')?.textContent === 'Selected'))
  await page.click('.grid .product:nth-child(3) .select')

  // Filter change scrolls back to the top and the grid reflows to the filtered set.
  await page.evaluate(() => window.scrollTo(0, 30000)); await sleep(400)
  await page.fill('input[placeholder="e.g. SJ-1001"]', 'SW 12'); await sleep(600)
  const filteredCount = await page.evaluate(() => Number(document.body.innerText.match(/(\d+) designs/)?.[1]))
  const y = await page.evaluate(() => window.scrollY)
  check('search filters the grid', filteredCount > 0 && filteredCount < COUNT, `${filteredCount} designs`)
  check('filter change scrolls to grid top', y < 900, `scrollY=${y}`)
  check('filtered first card matches', (await codes())[0]?.startsWith('SW 12'))
  await page.fill('input[placeholder="e.g. SJ-1001"]', ''); await sleep(500)

  // Viewer: open the first card, then jump far ahead with ArrowRight; the grid must follow.
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(300)
  await page.click('.grid .product:nth-child(1) .image-button'); await sleep(300)
  for (let i = 0; i < 200; i++) await page.keyboard.press('ArrowRight')
  await sleep(700)
  const visibleAfterNav = await codes()
  check('viewer navigation keeps current design in rendered window', visibleAfterNav.includes('SW 201'), `${visibleAfterNav[0]} … ${visibleAfterNav.at(-1)}`)
  await page.keyboard.press('Escape'); await sleep(300)
  const onScreen = await page.evaluate(() => { const s = [...document.querySelectorAll('.grid .product strong')].find(x => x.textContent === 'SW 201'); const r = s?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= innerHeight })
  check('closing viewer lands on the current design', onScreen)

  // Hidden tab → shown again (display:none round-trip) re-measures.
  await page.click('nav button:has-text("vendors")'); await sleep(300)
  await page.click('nav button:has-text("catalogue")'); await sleep(600)
  check('grid re-renders after tab switch', (await cards()) > 0 && (await codes()).length > 0)

  // Rotation: portrait iPad should give fewer columns than landscape.
  // Rotation: columns must match what CSS repeat(auto-fill,minmax(150px,1fr)) gives for the grid's width at each size.
  const cssCols = () => page.evaluate(() => Math.max(1, Math.floor((document.querySelector('.grid').getBoundingClientRect().width + 12) / 162)))
  const landscapeCols = await cols(), landscapeExpected = await cssCols()
  await page.setViewportSize({ width: 820, height: 1180 }); await sleep(600)
  const portraitCols = await cols(), portraitExpected = await cssCols()
  check('rotation re-lays out columns to match CSS grid', landscapeCols === landscapeExpected && portraitCols === portraitExpected, `landscape ${landscapeCols}/${landscapeExpected}, portrait ${portraitCols}/${portraitExpected}`)
  await page.setViewportSize({ width: 1366, height: 1024 }); await sleep(600)
  check('wide iPad Pro landscape matches CSS grid', (await cols()) === (await cssCols()), `${await cols()} columns`)
  await page.setViewportSize({ width: 820, height: 1180 }); await sleep(400)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await sleep(600)
  check('last product reachable in portrait', (await codes()).at(-1) === `SW ${COUNT}`)
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(600)
  check('phone width uses 2 columns', (await cols()) === 2, `${await cols()} columns`)
} finally {
  await context.close(); await rm(dir, { recursive: true, force: true }); preview.kill()
}
const failed = checks.filter(c => !c.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
