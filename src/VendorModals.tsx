import { useState } from 'react'
import type { Vendor } from './types'

interface EditVendorModalProps {
  vendor: Vendor
  existingVendors: Vendor[]
  onSave: (updated: Vendor) => Promise<void>
  onClose: () => void
}

export function EditVendorModal({ vendor, existingVendors, onSave, onClose }: EditVendorModalProps) {
  const [name, setName] = useState(vendor.name)
  const [address, setAddress] = useState(vendor.address)
  const [city, setCity] = useState(vendor.city)
  const [type, setType] = useState<Vendor['type']>(vendor.type || 'WHOLESALE')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    const trimmedAddress = address.trim()
    const trimmedCity = city.trim()

    if (!trimmedName || !trimmedAddress || !trimmedCity) {
      setError('Vendor name, business address, and city are required.')
      return
    }

    const normKey = `${trimmedName.toLowerCase()}|${trimmedCity.toLowerCase()}`
    const isDuplicate = existingVendors.some(
      v => v.id !== vendor.id && !v.deleted && `${v.name.trim().toLowerCase()}|${v.city.trim().toLowerCase()}` === normKey
    )

    if (isDuplicate) {
      setError(`A vendor named "${trimmedName}" in "${trimmedCity}" already exists. Vendor name and city combination must be unique.`)
      return
    }

    setSaving(true)
    setError('')
    try {
      await onSave({
        ...vendor,
        name: trimmedName,
        address: trimmedAddress,
        city: trimmedCity,
        type
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update vendor.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="product-edit-modal-backdrop" role="dialog" aria-modal="true" aria-label="Edit Vendor Details">
      <div className="product-edit-modal-card">
        <div className="product-edit-modal-header">
          <div>
            <p className="eyebrow">vendor directory</p>
            <h2>Edit Vendor Details</h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close edit modal">×</button>
        </div>

        {error && <p className="field-error" role="alert">{error}</p>}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <label>
            Vendor name
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              required
              autoFocus
            />
          </label>

          <label>
            Business address
            <input
              value={address}
              onChange={e => setAddress(e.target.value)}
              required
            />
          </label>

          <label>
            City
            <input
              value={city}
              onChange={e => setCity(e.target.value)}
              required
            />
          </label>

          <label>
            Vendor type
            <select value={type} onChange={e => setType(e.target.value as Vendor['type'])}>
              <option value="WHOLESALE">WHOLESALE</option>
              <option value="RETAIL">RETAIL</option>
              <option value="CORPORATE">CORPORATE</option>
            </select>
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
            <button type="button" className="quiet" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? 'Saving changes…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface ArchiveVendorModalProps {
  vendor: Vendor
  onConfirm: () => Promise<void>
  onClose: () => void
}

export function ArchiveVendorModal({ vendor, onConfirm, onClose }: ArchiveVendorModalProps) {
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState('')

  const handleConfirm = async () => {
    setArchiving(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive vendor.')
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="product-edit-modal-backdrop" role="dialog" aria-modal="true" aria-label="Archive Vendor Confirmation">
      <div className="product-edit-modal-card" style={{ maxWidth: '480px' }}>
        <div className="product-edit-modal-header">
          <div>
            <p className="eyebrow">archive vendor</p>
            <h2>Archive {vendor.name}?</h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close archive dialog">×</button>
        </div>

        {error && <p className="field-error" role="alert">{error}</p>}

        <p style={{ fontSize: '14px', lineHeight: 1.6, color: 'var(--ink)' }}>
          Archiving <strong>{vendor.name} ({vendor.city})</strong> hides this vendor from new order creation trays.
        </p>
        <p className="muted" style={{ fontSize: '13px', lineHeight: 1.5, marginTop: '8px' }}>
          Historical orders, order previews, and generated manufacturer PDFs retain all vendor details intact. You can restore this vendor at any time from the <em>Archived Vendors</em> tab.
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
            {archiving ? 'Archiving…' : '🗑️ Archive Vendor'}
          </button>
        </div>
      </div>
    </div>
  )
}
