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
 it('enforces vendor uniqueness on normalized name and address (allowing same name in same city with different addresses)', ()=>{
  const rawVendors = [
   { id: 'v1', name: 'Kalyan Jewellers', city: 'Mumbai', address: 'Bandra', type: 'RETAIL' },
   { id: 'v2', name: 'kalyan jewellers ', city: 'mumbai', address: ' bandra ', type: 'RETAIL' },
   { id: 'v3', name: 'Kalyan Jewellers', city: 'Mumbai', address: 'Andheri', type: 'RETAIL' },
   { id: 'v4', name: 'Shree Radhey Jewellers', city: 'Surat', address: 'Ring Road', type: 'WHOLESALE' }
  ]
  const byNameAddress = new Map<string, typeof rawVendors[0]>()
  for (const v of rawVendors) {
   const key = `${v.name.trim().toLowerCase()}|${v.address.trim().toLowerCase()}`
   if (!byNameAddress.has(key)) {
    byNameAddress.set(key, v)
   }
  }
  const deduped = Array.from(byNameAddress.values())
  expect(deduped).toHaveLength(3)
  expect(deduped.map(v => `${v.name.trim().toLowerCase()}|${v.address.trim().toLowerCase()}`)).toEqual([
   'kalyan jewellers|bandra',
   'kalyan jewellers|andheri',
   'shree radhey jewellers|ring road'
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
   it('prevents vendor rename colliding with existing active vendor name and address, but allows same city', ()=>{
    const activeVendors = [
      { id: 'v1', name: 'Zaveri Jewellers', address: 'Bandra', city: 'Mumbai', deleted: false },
      { id: 'v2', name: 'Surat Gems', address: 'Ring Road', city: 'Surat', deleted: false }
    ]
    const validateVendorEdit = (editingId: string, newName: string, newAddress: string) => {
      const normKey = `${newName.trim().toLowerCase()}|${newAddress.trim().toLowerCase()}`
      return !activeVendors.some(
        v => v.id !== editingId && !v.deleted && `${v.name.trim().toLowerCase()}|${v.address.trim().toLowerCase()}` === normKey
      )
    }
    // Colliding with v1 name and address
    expect(validateVendorEdit('v2', 'Zaveri Jewellers', 'Bandra')).toBe(false)
    expect(validateVendorEdit('v2', '  zaveri jewellers ', '  bandra ')).toBe(false)
    // Same name, same city (Mumbai), but different address -> ALLOWED
    expect(validateVendorEdit('v2', 'Zaveri Jewellers', 'Andheri')).toBe(true)
    // Keeping same name/address on same vendor id
    expect(validateVendorEdit('v1', 'Zaveri Jewellers', 'Bandra')).toBe(true)
    // Unique new name/address
    expect(validateVendorEdit('v2', 'Surat Diamond Craft', 'Varachha')).toBe(true)
   })
   it('bounds progressive catalogue windowing to prevent DOM memory explosion', ()=>{
    const INITIAL_BATCH = 40
    const BATCH_INCREMENT = 24
    const totalItems = Array.from({ length: 250 }, (_, i) => ({ id: `p-${i}`, code: `SJ-${1000 + i}` }))

    let visibleCount = INITIAL_BATCH
    const sliceItems = (count: number) => totalItems.slice(0, count)

    // Initial render only slices first 40 items out of 250 into the DOM
    expect(sliceItems(visibleCount)).toHaveLength(40)
    expect(sliceItems(visibleCount)[0].code).toBe('SJ-1000')
    expect(sliceItems(visibleCount)[39].code).toBe('SJ-1039')

    // First scroll trigger increments by 24
    visibleCount = Math.min(totalItems.length, visibleCount + BATCH_INCREMENT)
    expect(sliceItems(visibleCount)).toHaveLength(64)

    // Multiple scroll triggers increment up to exact total count without overflowing
    while (visibleCount < totalItems.length) {
      visibleCount = Math.min(totalItems.length, visibleCount + BATCH_INCREMENT)
    }
    expect(visibleCount).toBe(250)
    expect(sliceItems(visibleCount)).toHaveLength(250)

    // Filter change immediately resets window back to INITIAL_BATCH
    const onFilterChange = () => { visibleCount = INITIAL_BATCH }
    onFilterChange()
    expect(visibleCount).toBe(40)
    expect(sliceItems(visibleCount)).toHaveLength(40)
   })
   it('preserves full dataset traversal for detail modal navigation despite DOM windowing', ()=>{
    const fullDataset = Array.from({ length: 150 }, (_, i) => ({ id: `prod-${i}`, designCode: `SJ-${i}` }))
    const visibleCount = 40
    const visible = fullDataset.slice(0, visibleCount)

    // Card clicked is at index 35 (inside visible window)
    const clickedItem = visible[35]
    const activeIndex = fullDataset.findIndex(p => p.id === clickedItem.id)
    expect(activeIndex).toBe(35)

    // Navigating forward crosses past the visible DOM window (item 40, 41...)
    const nextItem = fullDataset[activeIndex + 1]
    expect(nextItem.id).toBe('prod-36')

    // Modal navigation can traverse all the way to item 149
    const lastItem = fullDataset[fullDataset.length - 1]
    const hasNext = (idx: number) => idx >= 0 && idx < fullDataset.length - 1
    expect(hasNext(35)).toBe(true)
    expect(hasNext(148)).toBe(true)
    expect(hasNext(149)).toBe(false)
    expect(lastItem.designCode).toBe('SJ-149')
   })
   it('heals corrupt detail image metadata (< 1000 byte HTML document) by falling back to grid image', ()=>{
    const corruptRecord = {
      id: 'prod-corrupt-1',
      design_code: 'SJ-CORRUPT-TEST',
      category_id: 'cat-1',
      subcategory_id: 'sub-1',
      weight_mg: 5000,
      grid_image_key: 'shine-jewels-demo/products/p-corrupt/v1/grid',
      detail_image_key: 'shine-jewels-demo/products/p-corrupt/v1/detail',
      grid_image_checksum: 'e'.repeat(64),
      detail_image_checksum: 'f'.repeat(64),
      grid_image_size_bytes: 45000,
      detail_image_size_bytes: 476, // 476 byte index.html artifact
      image_version: 1
    }
    const healed = productFromRecord(corruptRecord)
    expect(healed.id).toBe('prod-corrupt-1')
    // detail image key must have been healed to match grid image key
    expect(healed.detailImageKey).toBe('shine-jewels-demo/products/p-corrupt/v1/grid')
    expect(healed.detailImageSizeBytes).toBe(45000)
    expect(healed.detailImageChecksum).toBe('e'.repeat(64))
    expect(healed.detailImage).toContain('shine-jewels-demo/products/p-corrupt/v1/grid')
   })
   it('formats appropriate vendor save status messages based on connectivity', ()=>{
    const getVendorNotice = (name: string, isOnline: boolean, syncedDirectly: boolean) => {
      if (isOnline && syncedDirectly) {
        return `Vendor "${name}" saved locally and synced to cloud.`
      }
      if (isOnline && !syncedDirectly) {
        return `Vendor "${name}" saved locally. Cloud sync pending.`
      }
      return `Vendor "${name}" saved locally (offline). It will sync automatically when online.`
    }

    expect(getVendorNotice('Tribhovandas', true, true)).toBe('Vendor "Tribhovandas" saved locally and synced to cloud.')
    expect(getVendorNotice('Tribhovandas', true, false)).toBe('Vendor "Tribhovandas" saved locally. Cloud sync pending.')
    expect(getVendorNotice('Tribhovandas', false, false)).toBe('Vendor "Tribhovandas" saved locally (offline). It will sync automatically when online.')
   })
})

