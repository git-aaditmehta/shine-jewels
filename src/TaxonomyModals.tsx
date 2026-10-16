import { useState } from 'react'
import type { Category, Subcategory } from './types'

interface EditCategoryModalProps {
  category: Category
  existingCategories: Category[]
  onSave: (updated: Category) => Promise<void>
  onClose: () => void
}

export function EditCategoryModal({ category, existingCategories, onSave, onClose }: EditCategoryModalProps) {
  const [name, setName] = useState(category.name)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Category name cannot be empty.')
      return
    }
    const isDuplicate = existingCategories.some(
      c => c.id !== category.id && c.name.toLowerCase() === trimmed.toLowerCase()
    )
    if (isDuplicate) {
      setError(`A category named "${trimmed}" already exists.`)
      return
    }

    setSaving(true)
    setError('')
    try {
      await onSave({ ...category, name: trimmed })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update category.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="product-edit-modal-backdrop" role="dialog" aria-modal="true" aria-label="Edit Category Name">
      <div className="product-edit-modal-card" style={{ maxWidth: '440px' }}>
        <div className="product-edit-modal-header">
          <div>
            <p className="eyebrow">taxonomy</p>
            <h2>Rename Category</h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close dialog">×</button>
        </div>

        {error && <p className="field-error" role="alert">{error}</p>}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <label>
            Category Name
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              required
              autoFocus
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
            <button type="button" className="quiet" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Name'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface DeleteCategoryModalProps {
  category: Category
  productCount: number
  onConfirm: () => Promise<void>
  onClose: () => void
}

export function DeleteCategoryModal({ category, productCount, onConfirm, onClose }: DeleteCategoryModalProps) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  const handleConfirm = async () => {
    setDeleting(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete category.')
    } finally {
      setDeleting(false)
    }
  }

  const isBlocked = productCount > 0

  return (
    <div className="product-edit-modal-backdrop" role="dialog" aria-modal="true" aria-label="Delete Category">
      <div className="product-edit-modal-card" style={{ maxWidth: '480px' }}>
        <div className="product-edit-modal-header">
          <div>
            <p className="eyebrow" style={isBlocked ? { color: 'var(--danger)', fontWeight: 600 } : { color: 'var(--danger)', fontWeight: 600 }}>
              {isBlocked ? '⚠️ DELETION BLOCKED' : '⚠️ PERMANENT DELETE'}
            </p>
            <h2>{isBlocked ? `Cannot Delete "${category.name}"` : `Delete "${category.name}"?`}</h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close dialog">×</button>
        </div>

        {error && <p className="field-error" role="alert">{error}</p>}

        {isBlocked ? (
          <div>
            <div style={{ padding: '14px 16px', background: 'rgba(239,68,68,0.1)', border: '1px solid var(--danger)', borderRadius: '10px', marginBottom: 'var(--space-3)' }}>
              <strong style={{ color: 'var(--danger)', display: 'block', marginBottom: '6px' }}>
                ⚠️ Active Catalogue Dependency Detected
              </strong>
              <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--ink)' }}>
                This category is currently referenced by <strong>{productCount} active design(s)</strong> in your sales catalogue. To maintain catalogue integrity, you cannot delete a category that has designs in it. Please delete or reassign those designs first.
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
              <button type="button" className="primary" onClick={onClose}>
                Understood
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: '14px', lineHeight: 1.6, color: 'var(--ink)' }}>
              Are you sure you want to <strong>permanently delete</strong> category <strong>{category.name}</strong>?
            </p>
            <p className="muted" style={{ fontSize: '13px', lineHeight: 1.5, marginTop: '8px' }}>
              This category has 0 designs attached. It will be completely removed from the cloud and all devices. This action <strong>cannot be undone</strong>.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <button type="button" className="quiet" onClick={onClose} disabled={deleting}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}
                onClick={handleConfirm}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : '🗑️ Delete Category'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export const ArchiveCategoryModal = DeleteCategoryModal

interface EditSubcategoryModalProps {
  subcategory: Subcategory
  existingSubcategories: Subcategory[]
  onSave: (updated: Subcategory) => Promise<void>
  onClose: () => void
}

export function EditSubcategoryModal({ subcategory, existingSubcategories, onSave, onClose }: EditSubcategoryModalProps) {
  const [name, setName] = useState(subcategory.name)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Subcategory name cannot be empty.')
      return
    }
    const isDuplicate = existingSubcategories.some(
      s => s.id !== subcategory.id && s.categoryId === subcategory.categoryId && s.name.toLowerCase() === trimmed.toLowerCase()
    )
    if (isDuplicate) {
      setError(`A subcategory named "${trimmed}" already exists in this category.`)
      return
    }

    setSaving(true)
    setError('')
    try {
      await onSave({ ...subcategory, name: trimmed })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update subcategory.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="product-edit-modal-backdrop" role="dialog" aria-modal="true" aria-label="Edit Subcategory Name">
      <div className="product-edit-modal-card" style={{ maxWidth: '440px' }}>
        <div className="product-edit-modal-header">
          <div>
            <p className="eyebrow">taxonomy</p>
            <h2>Rename Subcategory</h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close dialog">×</button>
        </div>

        {error && <p className="field-error" role="alert">{error}</p>}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <label>
            Subcategory Name
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              required
              autoFocus
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
            <button type="button" className="quiet" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Name'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface DeleteSubcategoryModalProps {
  subcategory: Subcategory
  productCount: number
  onConfirm: () => Promise<void>
  onClose: () => void
}

export function DeleteSubcategoryModal({ subcategory, productCount, onConfirm, onClose }: DeleteSubcategoryModalProps) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  const handleConfirm = async () => {
    setDeleting(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete subcategory.')
    } finally {
      setDeleting(false)
    }
  }

  const isBlocked = productCount > 0

  return (
    <div className="product-edit-modal-backdrop" role="dialog" aria-modal="true" aria-label="Delete Subcategory">
      <div className="product-edit-modal-card" style={{ maxWidth: '480px' }}>
        <div className="product-edit-modal-header">
          <div>
            <p className="eyebrow" style={{ color: 'var(--danger)', fontWeight: 600 }}>
              {isBlocked ? '⚠️ DELETION BLOCKED' : '⚠️ PERMANENT DELETE'}
            </p>
            <h2>{isBlocked ? `Cannot Delete "${subcategory.name}"` : `Delete "${subcategory.name}"?`}</h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close dialog">×</button>
        </div>

        {error && <p className="field-error" role="alert">{error}</p>}

        {isBlocked ? (
          <div>
            <div style={{ padding: '14px 16px', background: 'rgba(239,68,68,0.1)', border: '1px solid var(--danger)', borderRadius: '10px', marginBottom: 'var(--space-3)' }}>
              <strong style={{ color: 'var(--danger)', display: 'block', marginBottom: '6px' }}>
                ⚠️ Active Catalogue Dependency Detected
              </strong>
              <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--ink)' }}>
                This subcategory is currently referenced by <strong>{productCount} active design(s)</strong> in your catalogue. To maintain catalogue integrity, you cannot delete a subcategory that has designs in it. Please delete or reassign those designs first.
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
              <button type="button" className="primary" onClick={onClose}>
                Understood
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: '14px', lineHeight: 1.6, color: 'var(--ink)' }}>
              Are you sure you want to <strong>permanently delete</strong> subcategory <strong>{subcategory.name}</strong>?
            </p>
            <p className="muted" style={{ fontSize: '13px', lineHeight: 1.5, marginTop: '8px' }}>
              This subcategory has 0 designs attached. It will be completely removed from the cloud and all devices. This action <strong>cannot be undone</strong>.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <button type="button" className="quiet" onClick={onClose} disabled={deleting}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}
                onClick={handleConfirm}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : '🗑️ Delete Subcategory'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export const ArchiveSubcategoryModal = DeleteSubcategoryModal
