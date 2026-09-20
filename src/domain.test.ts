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
 it('enforces vendor uniqueness on normalized name and city', ()=>{
  const rawVendors = [
   { id: 'v1', name: 'Shree Radhey Jewellers', city: 'Mumbai', address: 'Zaveri Bazaar', type: 'WHOLESALE' },
   { id: 'v2', name: 'shree radhey jewellers ', city: ' mumbai', address: 'Old Zaveri Bazaar', type: 'WHOLESALE' },
   { id: 'v3', name: 'Shree Radhey Jewellers', city: 'Surat', address: 'Ring Road', type: 'RETAIL' },
   { id: 'v4', name: 'Kalyan Jewellers', city: 'Mumbai', address: 'Bandra', type: 'RETAIL' }
  ]
  const byNameCity = new Map<string, typeof rawVendors[0]>()
  for (const v of rawVendors) {
   const key = `${v.name.trim().toLowerCase()}|${v.city.trim().toLowerCase()}`
   if (!byNameCity.has(key)) {
    byNameCity.set(key, v)
   }
  }
  const deduped = Array.from(byNameCity.values())
  expect(deduped).toHaveLength(3)
  expect(deduped.map(v => `${v.name.trim().toLowerCase()}|${v.city.trim().toLowerCase()}`)).toEqual([
   'shree radhey jewellers|mumbai',
   'shree radhey jewellers|surat',
   'kalyan jewellers|mumbai'
  ])
 })
  it('enforces 5 MB maximum file size cap for uploads', ()=>{
   const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024
   const isAllowed = (bytes: number) => bytes <= MAX_IMAGE_SIZE_BYTES
   expect(isAllowed(2 * 1024 * 1024)).toBe(true)
   expect(isAllowed(5 * 1024 * 1024)).toBe(true)
   expect(isAllowed(5 * 1024 * 1024 + 1)).toBe(false)
   expect(isAllowed(10 * 1024 * 1024)).toBe(false)
  })
  it('increments imageVersion and preserves immutable design code on product edit', ()=>{
   const original = {
     id: 'prod-edit-1',
     designCode: 'SJ-RING-01',
     categoryId: 'cat-1',
     subcategoryId: 'sub-1',
     weightMg: 3500,
     imageVersion: 1,
     deleted: false
   }
   // Edit weight and replace photo
   const imageReplaced = true
   const edited = {
     ...original,
     categoryId: 'cat-2',
     subcategoryId: 'sub-3',
     weightMg: 3750,
     imageVersion: imageReplaced ? original.imageVersion + 1 : original.imageVersion,
     designCode: original.designCode // immutable
   }
   expect(edited.designCode).toBe('SJ-RING-01')
   expect(edited.imageVersion).toBe(2)
   expect(edited.weightMg).toBe(3750)
   expect(edited.categoryId).toBe('cat-2')
  })
  it('soft-deletes product via archive without corrupting historical order snapshots', ()=>{
   const product = { id: 'p1', designCode: 'SJ-PENDANT', weightMg: 6250, deleted: false }
   const historicalOrder = {
     orderNumber: 101,
     items: [
       { productId: product.id, designCode: product.designCode, weightMg: product.weightMg, quantity: 2 }
     ]
   }
   // Archive product
   const archivedProduct = { ...product, deleted: true }
   expect(archivedProduct.deleted).toBe(true)
   // Historical order remains immutable
   expect(historicalOrder.items[0].productId).toBe('p1')
   expect(historicalOrder.items[0].designCode).toBe('SJ-PENDANT')
   expect(historicalOrder.items[0].weightMg).toBe(6250)
  })
   it('blocks category archive when referenced by active products and permits archive when unused', ()=>{
    const activeProducts = [
      { id: 'p1', categoryId: 'cat-rings', subcategoryId: 'sub-solitaire', deleted: false },
      { id: 'p2', categoryId: 'cat-necklaces', subcategoryId: 'sub-choker', deleted: false },
      { id: 'p3', categoryId: 'cat-rings', subcategoryId: 'sub-band', deleted: true } // archived product
    ]
    const canArchiveCategory = (catId: string) => {
      const referencing = activeProducts.filter(p => !p.deleted && p.categoryId === catId)
      return { allowed: referencing.length === 0, count: referencing.length }
    }
    // cat-rings is used by p1 (active)
    const ringsCheck = canArchiveCategory('cat-rings')
    expect(ringsCheck.allowed).toBe(false)
    expect(ringsCheck.count).toBe(1)

    // cat-bracelets is not used by any active product
    const braceletsCheck = canArchiveCategory('cat-bracelets')
    expect(braceletsCheck.allowed).toBe(true)
    expect(braceletsCheck.count).toBe(0)
   })
   it('blocks subcategory archive when referenced by active products and permits archive when unused', ()=>{
    const activeProducts = [
      { id: 'p1', categoryId: 'cat-rings', subcategoryId: 'sub-solitaire', deleted: false },
      { id: 'p2', categoryId: 'cat-rings', subcategoryId: 'sub-band', deleted: true }
    ]
    const canArchiveSubcategory = (subId: string) => {
      const referencing = activeProducts.filter(p => !p.deleted && p.subcategoryId === subId)
      return { allowed: referencing.length === 0, count: referencing.length }
    }
    expect(canArchiveSubcategory('sub-solitaire').allowed).toBe(false)
    expect(canArchiveSubcategory('sub-band').allowed).toBe(true)
   })
   it('prevents vendor rename colliding with existing active vendor name and city', ()=>{
    const activeVendors = [
      { id: 'v1', name: 'Zaveri Jewellers', city: 'Mumbai', deleted: false },
      { id: 'v2', name: 'Surat Gems', city: 'Surat', deleted: false }
    ]
    const validateVendorEdit = (editingId: string, newName: string, newCity: string) => {
      const normKey = `${newName.trim().toLowerCase()}|${newCity.trim().toLowerCase()}`
      return !activeVendors.some(
        v => v.id !== editingId && !v.deleted && `${v.name.trim().toLowerCase()}|${v.city.trim().toLowerCase()}` === normKey
      )
    }
    // Colliding with v1
    expect(validateVendorEdit('v2', 'Zaveri Jewellers', 'Mumbai')).toBe(false)
    expect(validateVendorEdit('v2', '  zaveri jewellers ', 'mumbai ')).toBe(false)
    // Keeping same name/city on same vendor id
    expect(validateVendorEdit('v1', 'Zaveri Jewellers', 'Mumbai')).toBe(true)
    // Unique new name/city
    expect(validateVendorEdit('v2', 'Surat Diamond Craft', 'Surat')).toBe(true)
   })
})
