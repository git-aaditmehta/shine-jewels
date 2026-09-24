import { execSync } from 'child_process'
import crypto from 'crypto'

async function main() {
  console.log('Querying products from D1...')
  const raw = execSync('npx wrangler d1 execute shine-jewels-production --remote --command="SELECT id, design_code, image_version, grid_image_key, detail_image_key, grid_image_size_bytes, detail_image_size_bytes, grid_image_checksum, detail_image_checksum FROM products WHERE deleted_at IS NULL;" --json', { encoding: 'utf8' })
  const parsed = JSON.parse(raw)
  const products = parsed[0].results

  console.log(`Found ${products.length} active products in D1.`)
  const r2Base = 'https://pub-ddd4389cc31a46b6b365e21911f96e1f.r2.dev'

  let totalImagesChecked = 0
  let okCount = 0
  let failCount = 0
  const issues = []

  for (const p of products) {
    const checks = [
      { type: 'grid', key: p.grid_image_key, expectedSize: p.grid_image_size_bytes, expectedChecksum: p.grid_image_checksum },
      { type: 'detail', key: p.detail_image_key, expectedSize: p.detail_image_size_bytes, expectedChecksum: p.detail_image_checksum }
    ]

    for (const c of checks) {
      if (!c.key) {
        issues.push({ product: p.design_code, type: c.type, issue: 'Key is empty/null' })
        failCount++
        continue
      }
      totalImagesChecked++
      const url = `${r2Base}/${c.key.split('/').map(encodeURIComponent).join('/')}`
      try {
        const res = await fetch(url)
        if (!res.ok) {
          issues.push({ product: p.design_code, type: c.type, key: c.key, issue: `HTTP status ${res.status}` })
          failCount++
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        const actualChecksum = crypto.createHash('sha256').update(buf).digest('hex')
        const actualSize = buf.length

        const sizeMismatch = c.expectedSize !== actualSize
        const checksumMismatch = c.expectedChecksum && c.expectedChecksum.toLowerCase() !== actualChecksum.toLowerCase()

        if (sizeMismatch || checksumMismatch) {
          issues.push({
            product: p.design_code,
            type: c.type,
            key: c.key,
            issue: `Mismatch! Expected size: ${c.expectedSize}, got: ${actualSize}. Expected sha: ${c.expectedChecksum?.slice(0, 10)}..., got: ${actualChecksum.slice(0, 10)}...`
          })
          failCount++
        } else {
          okCount++
        }
      } catch (err) {
        issues.push({ product: p.design_code, type: c.type, key: c.key, issue: `Fetch failed: ${err.message}` })
        failCount++
      }
    }
  }

  console.log(`\n=== RECOVERY DIAGNOSIS SUMMARY ===`)
  console.log(`Total images checked: ${totalImagesChecked}`)
  console.log(`Passed integrity & availability: ${okCount}`)
  console.log(`Failed / Unavailable: ${failCount}`)
  console.log('\nDetailed issues found:')
  console.dir(issues, { depth: null })
}

main().catch(console.error)
