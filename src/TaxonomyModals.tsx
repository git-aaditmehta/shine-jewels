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

interface ArchiveCategoryModalProps {
  category: Category
  productCount: number
  onConfirm: () => Promise<void>
  onClose: () => void
}

export function ArchiveCategoryModal({ category, productCount, onConfirm, onClose }: ArchiveCategoryModalProps) {
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState('')

  const handleConfirm = async () => {
    setArchiving(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive category.')
    } finally {
      setArchiving(false)
    }
  }

  const isBlocked = productCount > 0

  return (
    <div className="product-edit-modal-backdrop" role="dialog" aria-modal="true" aria-label="Archive Category">
      <div className="product-edit-modal-card" style={{ maxWidth: '480px' }}>
        <div className="product-edit-modal-header">
          <div>
            <p className="eyebrow">{isBlocked ? 'archival blocked' : 'archive category'}</p>
            <h2>{isBlocked ? `Cannot Archive "${category.name}"` : `Archive "${category.name}"?`}</h2>
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
                This category is currently referenced by <strong>{productCount} active design(s)</strong> in your sales catalogue. To maintain catalogue integrity, you must reassign or archive those designs first before archiving this category.
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
              Are you sure you want to archive <strong>{category.name}</strong>?
            </p>
            <p className="muted" style={{ fontSize: '13px', lineHeight: 1.5, marginTop: '8px' }}>
              Archiving removes this category from filter bars and new design entry forms. You can restore it anytime from the <em>Archived Taxonomy</em> tab.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <button type="button" className="quiet" onClick={onClose} disabled={archiving}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}
                onClick={handleConfirm}
                disabled={archiving}
              >
                {archiving ? 'Archiving…' : '🗑️ Archive Category'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

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

interface ArchiveSubcategoryModalProps {
  subcategory: Subcategory
  productCount: number
  onConfirm: () => Promise<void>
  onClose: () => void
}

export function ArchiveSubcategoryModal({ subcategory, productCount, onConfirm, onClose }: ArchiveSubcategoryModalProps) {
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState('')

  const handleConfirm = async () => {
    setArchiving(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive subcategory.')
    } finally {
      setArchiving(false)
    }
  }

  const isBlocked = productCount > 0

  return (
    <div className="product-edit-modal-backdrop" role="dialog" aria-modal="true" aria-label="Archive Subcategory">
      <div className="product-edit-modal-card" style={{ maxWidth: '480px' }}>
        <div className="product-edit-modal-header">
          <div>
            <p className="eyebrow">{isBlocked ? 'archival blocked' : 'archive subcategory'}</p>
            <h2>{isBlocked ? `Cannot Archive "${subcategory.name}"` : `Archive "${subcategory.name}"?`}</h2>
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
                This subcategory is currently referenced by <strong>{productCount} active design(s)</strong> in your catalogue. To maintain catalogue integrity, you must reassign or archive those designs first before archiving this subcategory.
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
              Are you sure you want to archive <strong>{subcategory.name}</strong>?
            </p>
            <p className="muted" style={{ fontSize: '13px', lineHeight: 1.5, marginTop: '8px' }}>
              Archiving removes this subcategory from filter bars and new design entry forms. You can restore it anytime from the <em>Archived Taxonomy</em> tab.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              <button type="button" className="quiet" onClick={onClose} disabled={archiving}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}
                onClick={handleConfirm}
                disabled={archiving}
              >
                {archiving ? 'Archiving…' : '🗑️ Archive Subcategory'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
