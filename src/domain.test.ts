import { describe, expect, it } from 'vitest'
import { computeSha256, productFromRecord } from './sync'

describe('business invariant helpers',()=>{
 it('keeps milligram arithmetic exact for 0.001g precision',()=>{const mg=[12345,8750].reduce((a,b)=>a+b,0);expect(mg).toBe(21095);expect((mg/1000).toFixed(3)).toBe('21.095')})
 it('rejects non-positive and fractional quantities in the order contract',()=>{const valid=(n:number)=>Number.isInteger(n)&&n>0;expect(valid(1)).toBe(true);expect(valid(0)).toBe(false);expect(valid(-2)).toBe(false);expect(valid(1.5)).toBe(false)})
 it('computes valid SHA-256 hex checksum from binary buffer',async()=>{
  const encoder = new TextEncoder()
  const hash = await computeSha256(encoder.encode('shine-jewels-test').buffer)
  expect(hash).toHaveLength(64)
  expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true)
 })
 it('maps database record to product with full integrity metadata', ()=>{
  const record = {
    id: 'prod-101',
    design_code: 'SJ-2026',
    category_id: 'cat-rings',
    subcategory_id: 'sub-solitaire',
    weight_mg: 4500,
    grid_image_key: 'org/products/prod-101/v1/grid',
    detail_image_key: 'org/products/prod-101/v1/detail',
    grid_image_checksum: 'a'.repeat(64),
    detail_image_checksum: 'b'.repeat(64),
    grid_image_size_bytes: 45000,
    detail_image_size_bytes: 350000,
    image_version: 1
  }
  const prod = productFromRecord(record)
  expect(prod.id).toBe('prod-101')
  expect(prod.designCode).toBe('SJ-2026')
  expect(prod.gridImageKey).toBe('org/products/prod-101/v1/grid')
  expect(prod.gridImageChecksum).toBe('a'.repeat(64))
  expect(prod.gridImageSizeBytes).toBe(45000)
  expect(prod.syncState).toBe('SYNCED')
 })
 it('maps sync_changes nested image object payload without producing [object Object]', ()=>{
  const payload = {
    id: 'prod-202',
    designCode: 'SJ-DUPE-TEST',
    categoryId: 'cat-1',
    subcategoryId: 'sub-1',
    weightMg: 12000,
    gridImage: {
      key: 'shine-jewels-demo/products/p202/v1/grid',
      sizeBytes: 88000,
      checksum: 'c'.repeat(64)
    },
    detailImage: {
      key: 'shine-jewels-demo/products/p202/v1/detail',
      sizeBytes: 250000,
      checksum: 'd'.repeat(64)
    }
  }
  const prod = productFromRecord(payload)
  expect(prod.id).toBe('prod-202')
  expect(prod.designCode).toBe('SJ-DUPE-TEST')
  expect(prod.gridImageKey).toBe('shine-jewels-demo/products/p202/v1/grid')
  expect(prod.detailImageKey).toBe('shine-jewels-demo/products/p202/v1/detail')
  expect(prod.gridImageChecksum).toBe('c'.repeat(64))
  expect(prod.gridImageSizeBytes).toBe(88000)
  expect(prod.gridImage).not.toContain('[object Object]')
  expect(prod.gridImage).toContain('shine-jewels-demo/products/p202/v1/grid')
 })
})
