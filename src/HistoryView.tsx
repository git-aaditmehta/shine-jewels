import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import type { Order, Vendor } from './types'

const grams = (mg: number) => (mg / 1000).toFixed(3)

type Props = {
  orders: Order[]
  generatingPdf: boolean
  onPreview: (order: Order) => void
}

/** One order reduced to what the History list shows and searches. Computed once per order list, not on every keystroke. */
type Row = {
  order: Order
  number: number
  vendorName: string
  vendorCity: string
  vendorType: string
  salesperson: string
  time: number
  dateStr: string
  totalQty: number
  totalWeight: number
  representatives: string
  /** Lower-case text matched by the search box: order number, vendor, city, salesperson, representatives, design codes. */
  haystack: string
}

function toRow(o: Order): Row {
  const vObj = (o.vendor as Partial<Vendor> | undefined) || {}
  const raw = o as unknown as Record<string, unknown>
  const vendorName = String(vObj.name || raw.vendor_name_snapshot || raw.vendorName || 'Vendor')
  const vendorCity = String(vObj.city || raw.vendor_city_snapshot || '')
  const vendorType = String(vObj.type || raw.vendor_type_snapshot || 'WHOLESALE')
  const number = Number(o.orderNumber || raw.order_number || 0)
  const items = Array.isArray(o.items) ? o.items : []
  const totalQty = items.reduce((n, i) => n + (i.quantity || 0), 0)
  const totalWeight = items.reduce((n, i) => n + (i.weightMg || 0) * (i.quantity || 1), 0)
  const date = new Date(o.generatedAt || o.createdAt || (raw.generated_at as string) || Date.now())
  const salesperson = String(o.salesperson || raw.salesperson_id || 'Salesperson')
  const representatives = (o.representatives || []).map(r => [r.name, r.phone].filter(Boolean).join(' ')).join(', ')
  const haystack = [`#${number}`, String(number).padStart(4, '0'), vendorName, vendorCity, salesperson, representatives, ...items.map(i => i.designCode || '')].join(' | ').toLowerCase().replace(/\s+/g, ' ')
  return { order: o, number, vendorName, vendorCity, vendorType, salesperson, time: date.getTime() || 0, dateStr: date.toLocaleString(), totalQty, totalWeight, representatives, haystack }
}

const dayStart = (value: string) => (value ? new Date(`${value}T00:00:00`).getTime() : NaN)

/**
 * Order history with search and filters (like the catalogue), drawn as a window-scrolled virtual list: only the orders
 * on screen are in the page, so thousands of orders stay smooth on the iPad.
 */
export function HistoryView({ orders, generatingPdf, onPreview }: Props) {
  const [query, setQuery] = useState('')
  const [vendorType, setVendorType] = useState('')
  const [salesperson, setSalesperson] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')

  const rows = useMemo(() => orders.map(toRow), [orders])
  const salespeople = useMemo(() => [...new Set(rows.map(r => r.salesperson))].sort((a, b) => a.localeCompare(b)), [rows])

  const filtered = useMemo(() => {
    // The text is matched as typed ("Vendor 7" finds that phrase), so numbers inside it don't match unrelated orders.
    const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ')
    const fromTime = dayStart(from), toTime = dayStart(to) + 86_400_000
    const list = rows.filter(r =>
      (!phrase || r.haystack.includes(phrase)) &&
      (!vendorType || r.vendorType === vendorType) &&
      (!salesperson || r.salesperson === salesperson) &&
      (Number.isNaN(fromTime) || r.time >= fromTime) &&
      (Number.isNaN(toTime) || r.time < toTime))
    // Newest first by order number, then by date for orders that do not have a number yet.
    list.sort((a, b) => (b.number - a.number) || (b.time - a.time))
    return sort === 'oldest' ? list.reverse() : list
  }, [rows, query, vendorType, salesperson, from, to, sort])

  const totals = useMemo(() => filtered.reduce((t, r) => ({ qty: t.qty + r.totalQty, weight: t.weight + r.totalWeight }), { qty: 0, weight: 0 }), [filtered])
  const filtering = !!(query || vendorType || salesperson || from || to)
  const clear = () => { setQuery(''); setVendorType(''); setSalesperson(''); setFrom(''); setTo('') }

  // Page offset of the list (the virtualizer's scrollMargin). Re-measured when the filters above it change size
  // (rotation, window resize, the Clear button appearing) or the list first appears.
  const listRef = useRef<HTMLDivElement | null>(null)
  const [listTop, setListTop] = useState(0)
  const hasList = filtered.length > 0
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = () => { const top = Math.round(el.getBoundingClientRect().top + window.scrollY); setListTop(prev => prev === top ? prev : top) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [hasList])
  const virtualizer = useWindowVirtualizer({
    count: filtered.length,
    estimateSize: () => 96,
    overscan: 6,
    scrollMargin: listTop,
    getItemKey: index => filtered[index].order.id
  })

  return (
    <main className="single-view">
      <div className="section-title">
        <div>
          <p className="eyebrow">synchronized history</p>
          <h1>Orders retain their original details.</h1>
        </div>
        <span>{filtering ? `${filtered.length} of ${rows.length}` : rows.length} orders · {totals.qty} pcs · {grams(totals.weight)} g</span>
      </div>

      <div className="history-filters">
        <label className="history-search">Search
          <input type="search" placeholder="Order no., vendor, city, design code, salesperson…" value={query} onChange={e => setQuery(e.target.value)} />
        </label>
        <label>Vendor type
          <select value={vendorType} onChange={e => setVendorType(e.target.value)}>
            <option value="">All types</option>
            <option value="WHOLESALE">Wholesale</option>
            <option value="RETAIL">Retail</option>
            <option value="CORPORATE">Corporate</option>
          </select>
        </label>
        <label>Salesperson
          <select value={salesperson} onChange={e => setSalesperson(e.target.value)}>
            <option value="">Everyone</option>
            {salespeople.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>From
          <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} />
        </label>
        <label>To
          <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} />
        </label>
        <label>Sort
          <select value={sort} onChange={e => setSort(e.target.value as 'newest' | 'oldest')}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        {filtering && <button type="button" className="quiet history-clear" onClick={clear}>Clear filters</button>}
      </div>

      {!rows.length ? (
        <p className="muted">No finalized orders on this device yet.</p>
      ) : !filtered.length ? (
        <p className="muted">No orders match these filters.</p>
      ) : (
        <div ref={listRef} className="history history-virtual" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(item => {
            const r = filtered[item.index]
            const items = Array.isArray(r.order.items) ? r.order.items : []
            return (
              <article
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="history-row"
                style={{ transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}
              >
                <div>
                  <strong>#{String(r.number).padStart(4, '0')} · {r.vendorName}{r.vendorCity ? `, ${r.vendorCity}` : ''}</strong>
                  <span>{r.dateStr} · {r.salesperson}{r.representatives ? ` · Rep: ${r.representatives}` : ''}</span>
                </div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <b>{r.totalQty} pcs · {grams(r.totalWeight)} g</b>
                  <button
                    type="button"
                    className="quiet"
                    style={{ minHeight: '32px', padding: '0 10px', fontSize: '12px' }}
                    onClick={() => onPreview(r.order)}
                    disabled={generatingPdf}
                  >
                    {generatingPdf ? 'Generating…' : 'Preview & Export PDF'}
                  </button>
                </div>
                <details>
                  <summary>View design snapshots ({items.length})</summary>
                  {items.length ? (
                    items.map((i, idx) => (
                      <p key={i.productId || idx}>
                        {i.designCode || 'Design'} · {i.category || ''}{i.subcategory ? `/${i.subcategory}` : ''} · {i.quantity || 1} × {grams(i.weightMg || 0)} g
                      </p>
                    ))
                  ) : (
                    <p className="muted" style={{ padding: '4px 0' }}>Order summary synchronized from cloud.</p>
                  )}
                </details>
              </article>
            )
          })}
        </div>
      )}
    </main>
  )
}
