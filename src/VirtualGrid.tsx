import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import type { Product } from './types'

/** Rows rendered above and below the visible screen. iPad landscape ≈ 6 columns, so 4 rows ≈ 24 cards each side. */
export const OVERSCAN_ROWS = 4
/** Mirrors `.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}` and the ≤480px 2-column rule. */
export const MIN_COLUMN_WIDTH = 150
export const GRID_GAP = 12
export const NARROW_BREAKPOINT = 480
export const NARROW_GAP = 8
export const NARROW_COLUMNS = 2
/** `.image-button{aspect-ratio:1.27}` plus the meta strip (padding 10 + 36px button + 10) and 1px borders. */
const IMAGE_ASPECT = 1.27
const META_HEIGHT = 58

/** Same result CSS `repeat(auto-fill, minmax(min, 1fr))` produces for a container of `width` px. */
export function columnsFor(width: number, viewportWidth: number): { columns: number; gap: number } {
  if (viewportWidth <= NARROW_BREAKPOINT) return { columns: NARROW_COLUMNS, gap: NARROW_GAP }
  if (width <= 0) return { columns: 0, gap: GRID_GAP }
  return { columns: Math.max(1, Math.floor((width + GRID_GAP) / (MIN_COLUMN_WIDTH + GRID_GAP))), gap: GRID_GAP }
}

export function rowHeightFor(width: number, columns: number, gap: number): number {
  if (columns <= 0) return 0
  const columnWidth = (width - gap * (columns - 1)) / columns
  return Math.round(columnWidth / IMAGE_ASPECT + META_HEIGHT) + gap
}

export function rowOf(index: number, columns: number) { return columns > 0 ? Math.floor(index / columns) : 0 }

type Props = {
  products: Product[]
  renderCard: (product: Product) => ReactNode
  /** Product that must be on screen (e.g. the one open in the fullscreen viewer). Scrolls only if it is outside the rendered rows. */
  scrollToId?: string | null
  /** Changes here reset the scroll to the top of the grid (e.g. a new filter). */
  resetKey?: string
  /** Called with the products just outside the rendered rows, so their photos can be read from disk before they scroll in. */
  onNearby?: (products: Product[]) => void
}

/** Rows beyond the rendered window whose photos are read ahead of time. */
export const READ_AHEAD_ROWS = 8

export function VirtualGrid({ products, renderCard, scrollToId, resetKey, onNearby }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [layout, setLayout] = useState({ width: 0, top: 0, columns: 0, gap: GRID_GAP })

  // Width and page offset of the grid. Width drives the column count; the offset is the virtualizer's scrollMargin.
  // Both change when the window resizes/rotates, when the catalogue tab is shown again (display:none → block),
  // and when content above the grid grows (notice banner, demo toolbar).
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      const top = Math.round(rect.top + window.scrollY)
      const { columns, gap } = columnsFor(rect.width, window.innerWidth)
      setLayout(prev => (prev.width === rect.width && prev.top === top && prev.columns === columns && prev.gap === gap) ? prev : { width: rect.width, top, columns, gap })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    observer.observe(document.body)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  const { columns, gap, width } = layout
  const rowCount = columns > 0 ? Math.ceil(products.length / columns) : 0
  const rowHeight = rowHeightFor(width, columns, gap)

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN_ROWS,
    scrollMargin: layout.top,
    getItemKey: index => `${columns}-${index}`
  })

  // Row height depends on width: re-measure rows after a resize/rotation so positions stay exact.
  useEffect(() => { virtualizer.measure() }, [rowHeight, virtualizer])

  // New filter → back to the top of the grid. Done before paint and again on the next frame, because the list
  // shrinks in the same commit and the browser clamps the old scroll position to the new (shorter) bottom.
  const previousResetKey = useRef(resetKey)
  useLayoutEffect(() => {
    if (resetKey === previousResetKey.current) return
    previousResetKey.current = resetKey
    const top = Math.max(0, layout.top - 16)
    if (window.scrollY <= top) return
    window.scrollTo(0, top)
    virtualizer.scrollToOffset(top)
    requestAnimationFrame(() => { if (window.scrollY > top) window.scrollTo(0, top) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // Keep the viewer's current product within the rendered window while swiping, and when the viewer closes
  // make sure the last-viewed product is actually on screen.
  const lastViewedId = useRef<string | null>(null)
  useEffect(() => {
    if (columns === 0) return
    const id = scrollToId ?? lastViewedId.current
    const closing = !scrollToId && !!lastViewedId.current
    lastViewedId.current = scrollToId ?? null
    if (!id) return
    const index = products.findIndex(p => p.id === id)
    if (index < 0) return
    const row = rowOf(index, columns)
    if (closing) { virtualizer.scrollToIndex(row, { align: 'auto' }); return }
    if (!virtualizer.getVirtualItems().some(item => item.index === row)) virtualizer.scrollToIndex(row, { align: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToId, columns])

  const items = virtualizer.getVirtualItems()
  const firstRow = items.length ? items[0].index : -1, lastRow = items.length ? items[items.length - 1].index : -1
  useEffect(() => {
    if (!onNearby || firstRow < 0 || columns === 0) return
    const before = products.slice(Math.max(0, firstRow - READ_AHEAD_ROWS) * columns, firstRow * columns)
    const after = products.slice((lastRow + 1) * columns, (lastRow + 1 + READ_AHEAD_ROWS) * columns)
    if (before.length || after.length) onNearby([...after, ...before])
  }, [firstRow, lastRow, columns, products, onNearby])
  return (
    <div ref={containerRef} className="grid virtual-grid" style={{ height: rowCount ? virtualizer.getTotalSize() : undefined }}>
      {items.map(item => {
        const start = item.index * columns
        const rowProducts = products.slice(start, start + columns)
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="virtual-grid-row"
            style={{ transform: `translateY(${item.start - layout.top}px)`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap, paddingBottom: gap }}
          >
            {rowProducts.map(renderCard)}
          </div>
        )
      })}
    </div>
  )
}
