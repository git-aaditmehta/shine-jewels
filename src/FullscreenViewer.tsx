import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { Category, Product, Subcategory } from './types'

export interface FullscreenViewerProps {
  detail: Product
  activeList: Product[]
  activeIndex: number
  hasPrev: boolean
  hasNext: boolean
  goPrev: () => void
  goNext: () => void
  onClose: () => void
  resolvedDetailUrl: string
  selected: Record<string, { quantity: number | ''; remark: string }>
  onToggle: (id: string) => void
  onUpdateSelected: (id: string, updates: Partial<{ quantity: number | ''; remark: string }>) => void
  categories: Category[]
  subcategories: Subcategory[]
  grams: (mg: number) => string
}

export function FullscreenViewer({
  detail,
  activeList,
  activeIndex,
  hasPrev,
  hasNext,
  goPrev,
  goNext,
  onClose,
  resolvedDetailUrl,
  selected,
  onToggle,
  onUpdateSelected,
  categories,
  subcategories,
  grams
}: FullscreenViewerProps) {
  // Zoom & Pan state
  const [zoom, setZoom] = useState<number>(1)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [showRemarkInput, setShowRemarkInput] = useState(false)
  const [tapEffect, setTapEffect] = useState<{ show: boolean; selected: boolean }>({ show: false, selected: false })

  // Touch & gesture tracking refs
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const lastTouchRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const initialPinchDistRef = useRef<number | null>(null)
  const initialZoomRef = useRef<number>(1)
  const lastTapTimeRef = useRef<number>(0)
  const dragMovedRef = useRef<boolean>(false)

  // Reset zoom & pan when detail product changes
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setIsPanning(false)
    setShowRemarkInput(Boolean(selected[detail.id]?.remark))
  }, [detail.id])

  // Selected state for current detail item
  const selectedItem = selected[detail.id]
  const isSelected = Boolean(selectedItem)

  // Category and subcategory names
  const categoryName = categories.find(c => c.id === detail.categoryId)?.name || 'Jewelry'
  const subcategoryName = subcategories.find(s => s.id === detail.subcategoryId)?.name || ''

  // Double-tap or zoom button handlers
  const handleZoomIn = () => setZoom(z => Math.min(3.5, Number((z + 0.5).toFixed(1))))
  const handleZoomOut = () => {
    setZoom(z => {
      const next = Math.max(1, Number((z - 0.5).toFixed(1)))
      if (next === 1) setPan({ x: 0, y: 0 })
      return next
    })
  }
  const handleResetZoom = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // Trigger tap selection with gold feedback ripple
  const triggerTapSelect = useCallback(() => {
    const nextState = !isSelected
    onToggle(detail.id)
    setTapEffect({ show: true, selected: nextState })
    setTimeout(() => {
      setTapEffect({ show: false, selected: false })
    }, 700)
  }, [detail.id, isSelected, onToggle])

  // Touch start handler
  const handleTouchStart = (e: React.TouchEvent) => {
    dragMovedRef.current = false
    if (e.touches.length === 2) {
      // Pinch gesture start
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      )
      initialPinchDistRef.current = dist
      initialZoomRef.current = zoom
      return
    }

    if (e.touches.length === 1) {
      const t = e.touches[0]
      touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() }
      lastTouchRef.current = { x: t.clientX, y: t.clientY }
      if (zoom > 1) {
        setIsPanning(true)
      }
    }
  }

  // Touch move handler
  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && initialPinchDistRef.current !== null) {
      // Pinch zoom in progress
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      )
      const ratio = dist / initialPinchDistRef.current
      const nextZoom = Math.min(3.5, Math.max(1, Number((initialZoomRef.current * ratio).toFixed(2))))
      setZoom(nextZoom)
      if (nextZoom === 1) setPan({ x: 0, y: 0 })
      dragMovedRef.current = true
      return
    }

    if (e.touches.length === 1 && touchStartRef.current) {
      const t = e.touches[0]
      const dx = t.clientX - lastTouchRef.current.x
      const dy = t.clientY - lastTouchRef.current.y
      const totalDist = Math.hypot(t.clientX - touchStartRef.current.x, t.clientY - touchStartRef.current.y)

      if (totalDist > 8) {
        dragMovedRef.current = true
      }

      if (zoom > 1.05) {
        // Pan zoomed image
        setPan(p => ({
          x: p.x + dx,
          y: p.y + dy
        }))
        lastTouchRef.current = { x: t.clientX, y: t.clientY }
      }
    }
  }

  // Touch end handler
  const handleTouchEnd = (e: React.TouchEvent) => {
    setIsPanning(false)
    initialPinchDistRef.current = null

    if (e.touches.length > 0) return

    if (!touchStartRef.current) return
    const now = Date.now()
    const elapsed = now - touchStartRef.current.time
    const deltaX = (lastTouchRef.current?.x ?? 0) - touchStartRef.current.x
    const isCleanTap = !dragMovedRef.current && elapsed < 320

    if (isCleanTap) {
      if (zoom > 1.05) {
        // Check double tap to reset zoom when zoomed in
        if (now - lastTapTimeRef.current < 300) {
          handleResetZoom()
          lastTapTimeRef.current = 0
          return
        }
        lastTapTimeRef.current = now
      } else {
        // Normal 1x zoom: check for double tap vs single tap
        if (now - lastTapTimeRef.current < 280) {
          // Double tap -> Zoom in 2.2x
          setZoom(2.2)
          lastTapTimeRef.current = 0
          return
        }
        lastTapTimeRef.current = now
        // Single tap -> Toggle design selection
        triggerTapSelect()
      }
    } else if (zoom <= 1.05 && Math.abs(deltaX) > 55) {
      // Horizontal swipe to navigate designs
      if (deltaX < 0 && hasNext) goNext()
      else if (deltaX > 0 && hasPrev) goPrev()
    }

    touchStartRef.current = null
  }

  // Mouse wheel zoom support for desktop/laptop
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    setZoom(z => {
      const delta = e.deltaY < 0 ? 0.25 : -0.25
      const next = Math.min(3.5, Math.max(1, Number((z + delta).toFixed(2))))
      if (next === 1) setPan({ x: 0, y: 0 })
      return next
    })
  }

  // Mouse double-click to toggle zoom on desktop
  const handleDoubleClick = () => {
    if (zoom > 1.05) {
      handleResetZoom()
    } else {
      setZoom(2.2)
    }
  }

  // Mouse drag pan support on desktop
  const mouseStartRef = useRef<{ x: number; y: number } | null>(null)
  const mouseMovedRef = useRef<boolean>(false)

  const handleMouseDown = (e: React.MouseEvent) => {
    mouseMovedRef.current = false
    mouseStartRef.current = { x: e.clientX, y: e.clientY }
    if (zoom > 1.05) {
      setIsPanning(true)
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!mouseStartRef.current) return
    const dx = e.clientX - mouseStartRef.current.x
    const dy = e.clientY - mouseStartRef.current.y
    if (Math.hypot(dx, dy) > 6) {
      mouseMovedRef.current = true
    }
    if (zoom > 1.05 && isPanning) {
      setPan(p => ({ x: p.x + dx, y: p.y + dy }))
      mouseStartRef.current = { x: e.clientX, y: e.clientY }
    }
  }

  const handleMouseUp = () => {
    if (!mouseMovedRef.current && zoom <= 1.05) {
      triggerTapSelect()
    }
    setIsPanning(false)
    mouseStartRef.current = null
  }

  // Quantity edit handler
  const handleQtyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    const parsed = val === '' ? '' : Math.max(1, parseInt(val, 10) || 1)
    onUpdateSelected(detail.id, { quantity: parsed })
  }

  // Remark edit handler
  const handleRemarkChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdateSelected(detail.id, { remark: e.target.value })
  }

  return (
    <div
      className="fullscreen-viewer-shell"
      role="dialog"
      aria-modal="true"
      aria-label={`${detail.designCode} full-screen viewer`}
      onWheel={handleWheel}
    >
      {/* 1. TOP FLOATING LUXURY TOOLBAR */}
      <header className="fullscreen-top-bar">
        <div className="fullscreen-header-left">
          <span className="fullscreen-index-badge">
            {activeIndex !== -1 ? `${activeIndex + 1} / ${activeList.length}` : 'Design Preview'}
          </span>
          <div className="fullscreen-title-box">
            <strong className="fullscreen-design-code">{detail.designCode}</strong>
            <span className="fullscreen-category-sub">{categoryName}{subcategoryName ? ` · ${subcategoryName}` : ''}</span>
          </div>
        </div>

        {/* Center Floating Tap Indicator */}
        <div
          className={`fullscreen-status-pill ${isSelected ? 'selected' : ''}`}
          onClick={triggerTapSelect}
          role="button"
          tabIndex={0}
          title="Click to toggle selection"
        >
          <span className="status-pill-dot" />
          <span>{isSelected ? '✓ Selected in Order' : '○ Tap Image to Select'}</span>
        </div>

        {/* Right Action Icons: Zoom Controls & Close */}
        <div className="fullscreen-header-right">
          <div className="fullscreen-zoom-toolbar">
            <button
              type="button"
              className="zoom-tool-btn"
              onClick={handleZoomOut}
              disabled={zoom <= 1}
              aria-label="Zoom out"
              title="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className="zoom-level-btn"
              onClick={handleResetZoom}
              title="Click to reset zoom (100%)"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="zoom-tool-btn"
              onClick={handleZoomIn}
              disabled={zoom >= 3.5}
              aria-label="Zoom in"
              title="Zoom in"
            >
              +
            </button>
          </div>

          <button
            type="button"
            className="fullscreen-close-btn"
            onClick={onClose}
            aria-label="Close full-screen view"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      </header>

      {/* 2. FULLSCREEN IMMERSIVE IMAGE STAGE */}
      <main
        className={`fullscreen-image-stage ${isPanning ? 'panning' : ''} ${zoom > 1.05 ? 'zoomed' : ''}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      >
        <div
          className={`fullscreen-img-wrapper ${isSelected ? 'is-selected' : ''}`}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transition: isPanning ? 'none' : 'transform 180ms cubic-bezier(0.2, 0, 0, 1)'
          }}
        >
          <img
            key={detail.id}
            src={resolvedDetailUrl || detail.gridImage}
            alt={`${detail.designCode} jewelry design`}
            className="fullscreen-jewelry-img"
            draggable={false}
          />

          {/* Quick gold selection ripple feedback */}
          {tapEffect.show && (
            <div className={`fullscreen-tap-ripple ${tapEffect.selected ? 'added' : 'removed'}`}>
              <span>{tapEffect.selected ? '✓ Added' : '✕ Removed'}</span>
            </div>
          )}
        </div>
      </main>

      {/* 3. FLOATING PREVIOUS & NEXT NAVIGATION BUTTONS */}
      {hasPrev && (
        <button
          type="button"
          className="fullscreen-nav-btn prev"
          onClick={goPrev}
          aria-label="Previous jewelry design"
          title="Previous (← arrow key)"
        >
          ‹
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          className="fullscreen-nav-btn next"
          onClick={goNext}
          aria-label="Next jewelry design"
          title="Next (→ arrow key)"
        >
          ›
        </button>
      )}

      {/* 4. CORNER FLOATING QUICK EDIT & ORDER WIDGET */}
      <aside className="fullscreen-quick-card">
        <div className="quick-card-header">
          <div>
            <div className="quick-card-title-row">
              <strong className="quick-card-code">{detail.designCode}</strong>
              <span className="quick-card-fixed-weight" title="Fixed jewelry weight">{grams(detail.weightMg)} g</span>
            </div>
            <span className="quick-card-sub">{categoryName}{subcategoryName ? ` / ${subcategoryName}` : ''}</span>
          </div>

          <button
            type="button"
            className={`quick-card-select-btn ${isSelected ? 'active' : ''}`}
            onClick={triggerTapSelect}
            aria-pressed={isSelected}
          >
            {isSelected ? '✓ Selected' : '+ Select Design'}
          </button>
        </div>

        <div className="quick-card-controls">
          {/* Quantity Box */}
          <div className="quick-control-group qty-group">
            <label htmlFor="quick-qty-input">Qty</label>
            <input
              id="quick-qty-input"
              type="number"
              min="1"
              step="1"
              placeholder="1"
              value={selectedItem?.quantity ?? 1}
              onChange={handleQtyChange}
              aria-label={`Quantity for ${detail.designCode}`}
            />
          </div>

          {/* Optional Remark Section */}
          <div className="quick-control-group remark-group">
            <label>Remark</label>
            {!showRemarkInput && !selectedItem?.remark ? (
              <button
                type="button"
                className="quick-remark-toggle-btn"
                onClick={() => setShowRemarkInput(true)}
              >
                💬 + Add optional remark
              </button>
            ) : (
              <div className="quick-remark-input-box">
                <input
                  type="text"
                  placeholder="Optional remark (e.g. 18K yellow gold, size 14)..."
                  value={selectedItem?.remark || ''}
                  onChange={handleRemarkChange}
                  aria-label={`Remark for ${detail.designCode}`}
                  autoFocus
                />
                {showRemarkInput && !selectedItem?.remark && (
                  <button
                    type="button"
                    className="quick-remark-close-btn"
                    onClick={() => setShowRemarkInput(false)}
                    title="Close remark"
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="quick-card-footer">
          <small>
            💡 Tap image once to select/deselect. Pinch or double-tap to zoom in.
          </small>
        </div>
      </aside>
    </div>
  )
}
