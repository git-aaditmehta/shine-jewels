// Bench-only stand-in for the Cloudflare Worker API and the R2 image bucket, on localhost.
// The bench build points the app at this server, so tests never touch the live (free-tier) Cloudflare account,
// and real network failures can be produced on demand (dropped connections, 429s, damaged downloads).
import { createServer } from 'node:http'

export const MOCK_PORT = 4330
export const MOCK_ORIGIN = `http://localhost:${MOCK_PORT}`

export async function startMockCloud({ latencyMs = 0 } = {}) {
  const cloud = {
    /** 'ok' | 'drop' (connection reset) | 'busy' (HTTP 429) | 'corrupt-once' (first download of each file is damaged) | 'gone' (404) */
    mode: 'ok', latencyMs, r2Gets: 0, r2Served: 0, uploads: new Map(), apiCalls: [], corrupted: new Set(),
    gridVariants: [], detailVariants: [], bootstrap: null, history: [], orderPosts: [], rejectOrders: false,
    /** signedOut: every API call except sign-in gets 401. codes: design code (lower case) → id of a design already in the cloud. */
    signedOut: false, codes: new Map(), productPosts: [],
    setVariants(seed) { cloud.gridVariants = seed.gridVariants.map(b => Buffer.from(b, 'base64')); cloud.detailVariants = seed.detailVariants.map(b => Buffer.from(b, 'base64')) },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
  }
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'cross-origin-resource-policy': 'cross-origin' }
  const body = req => new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))) })
  const json = (res, value, status = 200) => { res.writeHead(status, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, MOCK_ORIGIN), path = url.pathname
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }

    if (cloud.mode === 'drop' && !path.startsWith('/r2/')) return req.socket.destroy()
    if (path.startsWith('/r2-upload/')) { cloud.uploads.set(decodeURIComponent(path.slice('/r2-upload/'.length)), await body(req)); res.writeHead(200, cors); return res.end() }

    if (path.startsWith('/r2/')) {
      cloud.r2Gets++
      const key = decodeURIComponent(path.slice('/r2/'.length))
      if (cloud.latencyMs) await new Promise(r => setTimeout(r, cloud.latencyMs))
      if (cloud.mode === 'drop' || cloud.mode === 'drop-images') return req.socket.destroy()
      if (cloud.mode === 'busy') { res.writeHead(429, { ...cors, 'retry-after': '1' }); return res.end() }
      if (cloud.mode === 'gone') { res.writeHead(404, cors); return res.end() }
      const match = key.match(/bench-(\d+)\/v\d+\/(grid|detail)$/)
      let bytes = cloud.uploads.get(key)
      if (!bytes && match) { const list = match[2] === 'grid' ? cloud.gridVariants : cloud.detailVariants; bytes = list[Number(match[1]) % list.length] }
      if (!bytes) { res.writeHead(404, cors); return res.end() }
      if (cloud.mode === 'corrupt-once' && !cloud.corrupted.has(key)) { cloud.corrupted.add(key); bytes = Buffer.from(bytes); bytes[bytes.length >> 1] ^= 0xff }
      cloud.r2Served++
      res.writeHead(200, { ...cors, 'content-type': 'image/jpeg', 'content-length': bytes.length, 'cache-control': 'no-store' })
      return res.end(bytes)
    }

    if (path.startsWith('/api/')) {
      const route = path.slice(4), payload = req.method === 'GET' ? null : JSON.parse((await body(req)).toString() || 'null')
      cloud.apiCalls.push(`${req.method} ${route}`)
      if (cloud.signedOut && route !== '/auth/login') return json(res, { error: 'This device is signed out. Please sign in again.' }, 401)
      if (route === '/products/by-code') { const id = cloud.codes.get((url.searchParams.get('code') || '').trim().toLowerCase()); return json(res, { product: id ? { id, designCode: url.searchParams.get('code') } : null }) }
      if (route === '/auth/login') return json(res, { token: 'bench-token', user: { id: 'u', role: 'ADMIN', organizationId: 'bench', displayName: 'Bench' }, offlineAuthorizationExpiresAt: '2099-01-01T00:00:00.000Z' })
      if (route === '/sync/bootstrap') return json(res, cloud.bootstrap || { categories: [], subcategories: [], vendors: [], products: [], presentations: [], checkpoint: 1 })
      if (route === '/history') return json(res, cloud.history.map(o => ({ id: o.id, order_number: o.order_number })))
      if (route.startsWith('/orders/') && req.method === 'GET') { const o = cloud.history.find(x => x.id === route.slice(8)); return o ? json(res, { presentation: o, items: o.items || [] }) : json(res, { error: 'Order not found.' }, 404) }
      if (route === '/orders' && req.method === 'POST' && cloud.rejectOrders) return json(res, { error: 'Temporary server problem.' }, 500)
      if (route === '/orders' && req.method === 'POST') { cloud.orderPosts.push(payload); return json(res, { id: payload.id, order_number: 900 + cloud.orderPosts.length, status: 'FINALIZED', vendor_name_snapshot: 'Bench Jewellers', vendor_address_snapshot: '1 Test Road', vendor_city_snapshot: 'Mumbai', vendor_type_snapshot: 'WHOLESALE', items: payload.items }) }
      if (route.startsWith('/sync/changes') || ['/devices', '/staff'].includes(route)) return json(res, [])
      if (route === '/categories' || route === '/subcategories') return json(res, { ...payload, category_id: payload?.categoryId })
      if (route === '/images/upload-authorizations') {
        const key = `bench/products/${payload.productId}/v${payload.imageVersion}/${payload.representation}`
        return json(res, { key, url: `${MOCK_ORIGIN}/r2-upload/${key}`, headers: {}, sizeBytes: payload.sizeBytes, checksum: payload.checksum })
      }
      if (route === '/products' && req.method === 'POST') { cloud.productPosts.push(payload); return json(res, { id: payload.id }) }
      return json(res, { ok: true })
    }
    res.writeHead(404, cors); res.end()
  })
  await new Promise(resolve => server.listen(MOCK_PORT, resolve))
  return cloud
}
