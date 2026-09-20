import { useEffect, useState } from 'react'
import { MAX_IMAGE_SIZE_BYTES, processDualImages } from './Management'
import type { Category, Product, Subcategory } from './types'

const validWeight = (s: string) => /^\d+(\.\d{1,3})?$/.test(s) && Number(s) > 0
const grams = (mg: number) => (mg / 1000).toFixed(3)

export function EditProductModal({
  product,
  categories,
  subcategories,
  onSave,
  onClose
}: {
  product: Product
  categories: Category[]
  subcategories: Subcategory[]
  onSave: (updated: Product) => Promise<void>
  onClose: () => void
}) {
  const [categoryId, setCategoryId] = useState(product.categoryId)
  const [subcategoryId, setSubcategoryId] = useState(product.subcategoryId)
  const [weight, setWeight] = useState(grams(product.weightMg))
  const [replacementFile, setReplacementFile] = useState<File | null>(null)
  const [replacementPreview, setReplacementPreview] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Clear replacement object URL on change/unmount
  useEffect(() => {
    if (!replacementFile) {
      setReplacementPreview(null)
      return
    }
    const url = URL.createObjectURL(replacementFile)
    setReplacementPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [replacementFile])

  // If category changes and subcategory no longer belongs, reset subcategory
  const onCategoryChange = (newCatId: string) => {
    setCategoryId(newCatId)
    const validSubs = subcategories.filter(s => s.categoryId === newCatId)
    if (!validSubs.some(s => s.id === subcategoryId)) {
      setSubcategoryId(validSubs[0]?.id || '')
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) {
      setReplacementFile(null)
      return
    }
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      setError(`Image size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds 5 MB limit.`)
      e.target.value = ''
      setReplacementFile(null)
      return
    }
    setError('')
    setReplacementFile(file)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!categoryId) {
      setError('Please select a valid category.')
      return
    }
    if (!subcategoryId) {
      setError('Please select a valid subcategory.')
      return
    }
    if (!validWeight(weight)) {
      setError('Please enter a valid positive weight with up to 3 decimal places (milligrams).')
      return
    }

    setBusy(true)
    try {
      let gridImage = product.gridImage
      let detailImage = product.detailImage
      let imageVersion = product.imageVersion || 1
      let gridImageKey = product.gridImageKey
      let detailImageKey = product.detailImageKey
      let gridImageChecksum = product.gridImageChecksum
      let detailImageChecksum = product.detailImageChecksum

      if (replacementFile) {
        const dual = await processDualImages(replacementFile)
        gridImage = dual.gridImage
        detailImage = dual.detailImage
        imageVersion += 1
        // Reset remote keys to force direct upload of the new version
        gridImageKey = undefined
        detailImageKey = undefined
        gridImageChecksum = undefined
        detailImageChecksum = undefined
      }

      const updated: Product = {
        ...product,
        categoryId,
        subcategoryId,
        weightMg: Math.round(Number(weight) * 1000),
        gridImage,
        detailImage,
        imageVersion,
        gridImageKey,
        detailImageKey,
        gridImageChecksum,
        detailImageChecksum,
        syncState: 'PENDING_UPLOAD'
      }

      await onSave(updated)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update design.')
    } finally {
      setBusy(false)
    }
  }

  const availableSubs = subcategories.filter(s => s.categoryId === categoryId)

  return (
    <div className="product-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-modal-title">
      <div className="product-modal-card">
        <div className="product-modal-header">
          <div>
            <p className="eyebrow">catalogue management</p>
            <h2 id="edit-modal-title">Edit Design {product.designCode}</h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close modal">×</button>
        </div>

        <form onSubmit={handleSubmit} className="product-modal-form">
          <div className="product-modal-grid">
            <div className="product-modal-col">
              <label>
                Design Code (Permanent)
                <input
                  value={product.designCode}
                  disabled
                  readOnly
                  className="immutable-input"
                  title="Design code cannot be changed once created (PRD Section 4.4)"
                />
                <small className="field-hint">🔒 Design code is permanent and immutable.</small>
              </label>

              <label>
                Category
                <select value={categoryId} onChange={e => onCategoryChange(e.target.value)} required>
                  <option value="">Choose category</option>
                  {categories.map(c => (
                    <option value={c.id} key={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>

              <label>
                Subcategory
                <select
                  value={subcategoryId}
                  onChange={e => setSubcategoryId(e.target.value)}
                  required
                  disabled={!categoryId}
                >
                  <option value="">Choose subcategory</option>
                  {availableSubs.map(s => (
                    <option value={s.id} key={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>

              <label>
                Weight (g)
                <input
                  type="number"
                  step="0.001"
                  min="0.001"
                  value={weight}
                  onChange={e => setWeight(e.target.value)}
                  required
                />
                <small className="field-hint">Precision up to 0.001 g (1 milligram).</small>
              </label>
            </div>

            <div className="product-modal-col">
              <label>Current Design Photo (v{product.imageVersion || 1})</label>
              <div className="edit-current-image-box">
                <img
                  src={replacementPreview || product.detailImage || product.gridImage}
                  alt={product.designCode}
                  className="edit-image-preview"
                />
                {replacementPreview && (
                  <span className="replacement-badge">New Photo Selected (v{(product.imageVersion || 1) + 1})</span>
                )}
              </div>

              <label style={{ marginTop: 'var(--space-2)' }}>
                Replace Photo (Optional)
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                />
                <small className="field-hint">Max 5MB. Supports iPad/phone camera and photo library.</small>
              </label>

              {replacementFile && (
                <div className="replacement-action-row">
                  <span className="muted" style={{ fontSize: '12px' }}>
                    {replacementFile.name} ({(replacementFile.size / 1024).toFixed(0)} KB)
                  </span>
                  <button
                    type="button"
                    className="quiet"
                    style={{ minHeight: '32px', padding: '0 8px', fontSize: '11px' }}
                    onClick={() => setReplacementFile(null)}
                  >
                    Keep Current Photo
                  </button>
                </div>
              )}
            </div>
          </div>

          {error && <p className="field-error" role="alert">{error}</p>}

          <div className="product-modal-footer">
            <button type="button" className="quiet" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving Changes…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function ArchiveConfirmModal({
  product,
  onConfirm,
  onClose
}: {
  product: Product
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const handleConfirm = async () => {
    setBusy(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive design.')
      setBusy(false)
    }
  }

  return (
    <div className="product-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="archive-modal-title">
      <div className="product-modal-card" style={{ maxWidth: '520px' }}>
        <div className="product-modal-header">
          <div>
            <p className="eyebrow" style={{ color: 'var(--danger)' }}>soft delete / archive</p>
            <h2 id="archive-modal-title">Archive {product.designCode}?</h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close modal">×</button>
        </div>

        <div className="archive-modal-body">
          <div className="archive-product-preview">
            <img src={product.gridImage} alt={product.designCode} />
            <div>
              <strong>{product.designCode}</strong>
              <span>{(product.weightMg / 1000).toFixed(3)} g</span>
            </div>
          </div>

          <p style={{ margin: '14px 0 8px', fontSize: '14px', lineHeight: 1.5 }}>
            Archiving hides this design from the active sales catalogue and manufacturer orders.
          </p>
          <ul style={{ margin: '0 0 16px', paddingLeft: '20px', fontSize: '13px', color: 'var(--muted)', lineHeight: 1.6 }}>
            <li>Existing finalized order history and PDFs will remain <strong>completely intact</strong>.</li>
            <li>You can restore this design at any time from <strong>Catalogue Administration</strong>.</li>
          </ul>

          {error && <p className="field-error" role="alert">{error}</p>}
        </div>

        <div className="product-modal-footer">
          <button type="button" className="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary danger-btn"
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? 'Archiving…' : 'Archive Design'}
          </button>
        </div>
      </div>
    </div>
  )
}
