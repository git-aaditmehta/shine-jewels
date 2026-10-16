import type { Category, Order, Product, Subcategory, Vendor } from './types'
import { storage } from './storage'
import { jsPDF } from 'jspdf'

const grams = (mg: number) => (mg / 1000).toFixed(3)

function formatFileDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  return `${day}-${month}-${year}`
}

async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (res.ok) {
      const blob = await res.blob()
      return new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result as string)
        reader.onerror = () => resolve('')
        reader.readAsDataURL(blob)
      })
    }
  } catch (e) {
    // Network or fetch failure
  }
  return null
}

export interface ResolvedItemImage {
  dataUrl: string
  width: number
  height: number
  format: 'JPEG' | 'PNG'
}

async function loadResolvedImage(source: string): Promise<ResolvedItemImage | null> {
  if (!source) return null
  let src = source

  if (src.startsWith('http://') || src.startsWith('https://')) {
    const fetched = await urlToDataUrl(src)
    if (fetched) {
      src = fetched
    }
  }

  return new Promise((resolve) => {
    const img = new Image()
    if (src.startsWith('http://') || src.startsWith('https://')) {
      img.crossOrigin = 'anonymous'
    }
    img.onload = () => {
      try {
        const w = img.naturalWidth || 400
        const h = img.naturalHeight || 400
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve({
            dataUrl: src,
            width: w,
            height: h,
            format: src.startsWith('data:image/png') ? 'PNG' : 'JPEG',
          })
          return
        }
        // Ensure transparent PNGs have a clean white background so designs render crisp & clear
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)

        resolve({
          dataUrl: canvas.toDataURL('image/jpeg', 0.92),
          width: w,
          height: h,
          format: 'JPEG',
        })
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

async function resolveItemThumbnail(
  item: Order['items'][number],
  localProducts: Product[]
): Promise<ResolvedItemImage | null> {
  // STRICT REQUIREMENT: Only the grid image is used for Manufacturer and Client Order copies.
  const prod = localProducts.find(
    p => (item.productId && p.id === item.productId) ||
         (item.designCode && p.designCode.trim().toLowerCase() === item.designCode.trim().toLowerCase())
  )

  let gridSource: string | null = null

  if (prod) {
    if (prod.gridImage && prod.gridImage.startsWith('data:')) {
      gridSource = prod.gridImage
    } else {
      // Look up OPFS grid cache
      const keysToTry = [
        `${prod.id}-grid-v${prod.imageVersion || 1}`,
        prod.gridImageKey,
        prod.gridImage,
      ]
      for (const key of keysToTry) {
        if (key && !key.startsWith('http://') && !key.startsWith('https://') && !key.startsWith('data:')) {
          const cached = await storage.getImage(key)
          if (cached) {
            gridSource = cached
            break
          }
        }
      }
      if (!gridSource && prod.gridImage) {
        gridSource = prod.gridImage
      }
    }
  }

  // Fallback to order item's snapshot image (which is gridImage saved when order was created)
  if (!gridSource && item.image) {
    if (item.image.startsWith('data:') || item.image.startsWith('http://') || item.image.startsWith('https://')) {
      gridSource = item.image
    } else {
      const cached = await storage.getImage(item.image)
      if (cached) gridSource = cached
    }
  }

  if (!gridSource) return null

  return loadResolvedImage(gridSource)
}

export interface GeneratedPdfResult {
  blob: Blob
  blobUrl: string
  fileName: string
  order?: Order
  totalQuantity: number
  totalWeightMg: number
  copyType?: 'client' | 'manufacturer' | 'demo'
  itemCount?: number
}

function normalizeOrderForPdf(order: Order): Order {
  const vObj = (order.vendor as Partial<Vendor> | undefined) || {}
  const raw = order as unknown as Record<string, unknown>
  const vendorName = String(vObj.name || raw.vendor_name_snapshot || raw.vendorName || 'Unknown Vendor')
  const vendorAddress = String(vObj.address || raw.vendor_address_snapshot || raw.vendorAddress || '')
  const vendorCity = String(vObj.city || raw.vendor_city_snapshot || raw.vendorCity || '')
  const vendorType = String(vObj.type || raw.vendor_type_snapshot || raw.vendorType || 'WHOLESALE') as Vendor['type']
  const vendor: Vendor = { id: String(vObj.id || raw.vendor_id || ''), name: vendorName, address: vendorAddress, city: vendorCity, type: vendorType }

  const orderNumber = Number(order.orderNumber || raw.order_number || 0)
  const items = Array.isArray(order.items) ? order.items : []
  const rawReps = Array.isArray(order.representatives)
    ? order.representatives
    : Array.isArray(raw.representatives)
      ? (raw.representatives as Record<string, unknown>[])
      : []
  const representatives = rawReps.map(r => ({
    name: String(r.name || '').trim(),
    phone: String(r.phone || '').trim()
  })).filter(r => r.name || r.phone)

  return {
    ...order,
    orderNumber,
    vendor,
    representatives: representatives.length ? representatives : undefined,
    items,
    salesperson: String(order.salesperson || raw.salesperson_id || 'Salesperson'),
    generatedAt: String(order.generatedAt || raw.generated_at || order.createdAt || new Date().toISOString())
  }
}


let cachedLogoWatermarkDataUrl: string | null = null
let cachedHeaderLogoBadgeDataUrl: string | null = null

async function getLogoWatermarkDataUrl(): Promise<string | null> {
  if (cachedLogoWatermarkDataUrl) return cachedLogoWatermarkDataUrl
  try {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = 600
          canvas.height = 600
          const ctx = canvas.getContext('2d')
          if (!ctx) return resolve(null)
          ctx.clearRect(0, 0, 600, 600)
          ctx.globalAlpha = 0.085
          ctx.drawImage(img, 0, 0, 600, 600)
          const data = canvas.toDataURL('image/png')
          cachedLogoWatermarkDataUrl = data
          resolve(data)
        } catch {
          resolve(null)
        }
      }
      img.onerror = () => resolve(null)
      img.src = '/logo.png'
    })
  } catch {
    return null
  }
}

async function getHeaderLogoBadgeDataUrl(): Promise<string | null> {
  if (cachedHeaderLogoBadgeDataUrl) return cachedHeaderLogoBadgeDataUrl
  try {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = 300
          canvas.height = 300
          const ctx = canvas.getContext('2d')
          if (!ctx) return resolve(null)
          // Circular dark badge with gold border
          ctx.beginPath()
          ctx.arc(150, 150, 146, 0, Math.PI * 2)
          ctx.fillStyle = '#0c0906'
          ctx.fill()
          ctx.lineWidth = 6
          ctx.strokeStyle = '#d4a03a'
          ctx.stroke()
          // Clip and draw logo zoomed 1.36x
          ctx.save()
          ctx.beginPath()
          ctx.arc(150, 150, 142, 0, Math.PI * 2)
          ctx.clip()
          const scale = 1.36
          const dw = 300 * scale
          const dh = 300 * scale
          ctx.drawImage(img, (300 - dw) / 2, (300 - dh) / 2, dw, dh)
          ctx.restore()
          const data = canvas.toDataURL('image/png')
          cachedHeaderLogoBadgeDataUrl = data
          resolve(data)
        } catch {
          resolve(null)
        }
      }
      img.onerror = () => resolve(null)
      img.src = '/logo.png'
    })
  } catch {
    return null
  }
}

export interface OrderPdfOptions {
  copyType?: 'client' | 'manufacturer'
}

export async function createOrderPdfBlob(rawOrder: Order, options?: OrderPdfOptions): Promise<GeneratedPdfResult> {
  const isManufacturer = options?.copyType === 'manufacturer'
  const order = normalizeOrderForPdf(rawOrder)
  if (!order.orderNumber) throw new Error('An order number is required before PDF generation.')

  // Resolve all images and branding assets concurrently before laying out PDF
  const localProducts = await storage.products().catch(() => [])
  const [itemImages, watermarkDataUrl, headerLogoDataUrl] = await Promise.all([
    Promise.all(order.items.map(item => resolveItemThumbnail(item, localProducts))),
    getLogoWatermarkDataUrl(),
    getHeaderLogoBadgeDataUrl(),
  ])

  const pdf = new jsPDF({ unit: 'mm', format: 'a4' })
  const orderDate = new Date(order.generatedAt || order.createdAt || Date.now())

  // Function to draw the obsidian black page background and logo watermark
  const drawPageBackground = (p: jsPDF) => {
    // 1. Deep obsidian luxury background
    p.setFillColor(8, 7, 5)
    p.rect(0, 0, 210, 297, 'F')

    // 2. Imprint transparent gold logo watermark in page center
    if (watermarkDataUrl) {
      try {
        p.addImage(watermarkDataUrl, 'PNG', 40, 85, 130, 130, undefined, 'FAST')
      } catch {
        // watermark non-blocking
      }
    }
  }

  const drawHeader = (startY: number) => {
    // Elegant polished gold top accent line
    pdf.setFillColor(212, 160, 58)
    pdf.rect(14, startY, 182, 1.2, 'F')

    // Circular Gold Logo Emblem (left)
    if (headerLogoDataUrl) {
      try {
        pdf.addImage(headerLogoDataUrl, 'PNG', 14, startY + 2.5, 16, 16)
      } catch {
        // fallback mark
      }
    }

    // Company branding text (placed beside the 16mm logo badge)
    const brandTextX = headerLogoDataUrl ? 33 : 14

    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(17)
    pdf.setTextColor(232, 184, 75) // Polished Gold
    pdf.text('SHINE JEWELS', brandTextX, startY + 8.5)

    pdf.setFontSize(7.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(240, 230, 210) // Soft Champagne Gold
    pdf.text('WE BRING THE SPARKLE YOU MAKE IT SHINE', brandTextX, startY + 13)

    pdf.setFontSize(6.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(190, 145, 60) // Warm Gold
    pdf.text(isManufacturer ? 'CONFIDENTIAL MANUFACTURER ORDER SHEET' : 'OFFICIAL CLIENT ORDER SHEET', brandTextX, startY + 17)

    if (isManufacturer) {
      // Manufacturer Copy: Integrated Order Number & Details Badge on right (NO vendor/rep boxes)
      pdf.setFillColor(18, 14, 10)
      pdf.setDrawColor(212, 160, 58)
      pdf.roundedRect(114, startY + 2.5, 82, 16, 2, 2, 'FD')

      // Golden vertical accent bar
      pdf.setFillColor(212, 160, 58)
      pdf.rect(114, startY + 2.5, 2.5, 16, 'F')

      // Divider inside badge
      pdf.setDrawColor(60, 45, 30)
      pdf.line(150, startY + 4, 150, startY + 17)

      // Left: Order Number
      pdf.setFontSize(6.5)
      pdf.setFont('helvetica', 'bold')
      pdf.setTextColor(190, 145, 60)
      pdf.text('ORDER NUMBER', 119, startY + 7)

      pdf.setFontSize(12.5)
      pdf.setFont('helvetica', 'bold')
      pdf.setTextColor(255, 217, 119)
      pdf.text(`#${String(order.orderNumber).padStart(4, '0')}`, 119, startY + 14)

      // Right: Order Details
      pdf.setFontSize(6.5)
      pdf.setFont('helvetica', 'normal')
      pdf.setTextColor(247, 244, 237)
      pdf.text(`Date: ${orderDate.toLocaleDateString('en-GB')}`, 154, startY + 7)
      pdf.text(`Time: ${orderDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 154, startY + 11.5)
      pdf.text(`Sales Rep: ${order.salesperson || 'Salesperson'}`, 154, startY + 16)
    } else {
      // Client Copy: Order number badge (top right)
      pdf.setFillColor(18, 14, 10)
      pdf.setDrawColor(212, 160, 58)
      pdf.roundedRect(144, startY + 3, 52, 14, 2, 2, 'FD')

      pdf.setFontSize(7)
      pdf.setFont('helvetica', 'bold')
      pdf.setTextColor(190, 145, 60)
      pdf.text('ORDER NUMBER', 148, startY + 7.5)

      pdf.setFontSize(12)
      pdf.setFont('helvetica', 'bold')
      pdf.setTextColor(255, 217, 119) // Bright Polished Gold
      pdf.text(`#${String(order.orderNumber).padStart(4, '0')}`, 148, startY + 13.5)

      // Vendor, Vendor Representative, and Order metadata card
      const cardHeight = 25
      pdf.setFillColor(18, 14, 10)
      pdf.setDrawColor(169, 119, 43)
      pdf.roundedRect(14, startY + 19, 182, cardHeight, 2, 2, 'FD')

      // Vertical dividers between the 3 sections
      pdf.setDrawColor(60, 45, 30)
      pdf.line(80, startY + 21, 80, startY + 19 + cardHeight - 2)
      pdf.line(138, startY + 21, 138, startY + 19 + cardHeight - 2)

      // 1. Vendor info (Col 1: 14 to 80 mm)
      pdf.setFontSize(7)
      pdf.setFont('helvetica', 'bold')
      pdf.setTextColor(212, 160, 58)
      pdf.text('VENDOR INFORMATION', 17, startY + 24)

      pdf.setFontSize(10)
      pdf.setFont('helvetica', 'bold')
      pdf.setTextColor(255, 255, 255)
      const vendorNameDisplay = pdf.splitTextToSize(order.vendor.name, 60)[0] || order.vendor.name
      pdf.text(vendorNameDisplay, 17, startY + 29)

      pdf.setFontSize(7)
      pdf.setFont('helvetica', 'normal')
      pdf.setTextColor(180, 168, 152)
      const vendorAddrLine = `${order.vendor.address}, ${order.vendor.city}`
      const splitAddr = pdf.splitTextToSize(vendorAddrLine, 60)
      pdf.text(splitAddr[0] || vendorAddrLine, 17, startY + 34)
      pdf.text(`Type: ${order.vendor.type}`, 17, startY + 38.5)

      // 2. Vendor Representative(s) (Col 2: 80 to 138 mm)
      pdf.setFontSize(7)
      pdf.setFont('helvetica', 'bold')
      pdf.setTextColor(212, 160, 58)
      pdf.text('VENDOR REPRESENTATIVE', 83, startY + 24)

      const reps = (order.representatives || []).filter(r => (r.name && r.name.trim()) || (r.phone && r.phone.trim()))
      if (reps.length === 0) {
        pdf.setFontSize(8)
        pdf.setFont('helvetica', 'normal')
        pdf.setTextColor(180, 168, 152)
        pdf.text('—', 83, startY + 30)
      } else if (reps.length === 1) {
        const rep = reps[0]
        pdf.setFontSize(9)
        pdf.setFont('helvetica', 'bold')
        pdf.setTextColor(255, 255, 255)
        pdf.text(rep.name.trim() || '—', 83, startY + 29)

        pdf.setFontSize(7.5)
        pdf.setFont('helvetica', 'normal')
        pdf.setTextColor(180, 168, 152)
        pdf.text(rep.phone.trim() ? `Tel: ${rep.phone.trim()}` : '—', 83, startY + 34.5)
      } else {
        let repY = startY + 28.5
        reps.slice(0, 3).forEach((rep) => {
          pdf.setFontSize(7.5)
          pdf.setFont('helvetica', 'bold')
          pdf.setTextColor(255, 255, 255)
          const repNameText = rep.name.trim() || '—'
          const repPhoneText = rep.phone.trim() ? ` (${rep.phone.trim()})` : ''
          const fullRepText = pdf.splitTextToSize(`${repNameText}${repPhoneText}`, 53)[0] || `${repNameText}${repPhoneText}`
          pdf.text(`• ${fullRepText}`, 83, repY)
          repY += 4.5
        })
        if (reps.length > 3) {
          pdf.setFontSize(6.5)
          pdf.setFont('helvetica', 'italic')
          pdf.setTextColor(180, 168, 152)
          pdf.text(`+${reps.length - 3} more`, 83, repY)
        }
      }

      // 3. Order Details (Col 3: 138 to 196 mm)
      pdf.setFontSize(7)
      pdf.setFont('helvetica', 'bold')
      pdf.setTextColor(212, 160, 58)
      pdf.text('ORDER DETAILS', 141, startY + 24)

      pdf.setFontSize(7)
      pdf.setFont('helvetica', 'normal')
      pdf.setTextColor(247, 244, 237)
      pdf.text(`Date: ${orderDate.toLocaleDateString('en-GB')}`, 141, startY + 29)
      pdf.text(`Time: ${orderDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 141, startY + 33.5)
      pdf.text(`Sales Rep: ${order.salesperson || 'Salesperson'}`, 141, startY + 38)
    }
  }

  const drawTableColumnHeader = (tableY: number) => {
    pdf.setFillColor(26, 20, 14)
    pdf.setDrawColor(212, 160, 58)
    pdf.rect(14, tableY, 182, 8, 'FD')

    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(255, 217, 119) // Polished Gold
    pdf.text('#', 17, tableY + 5.5)
    pdf.text('PREVIEW', 27, tableY + 5.5)
    pdf.text('DESIGN DETAILS', 54, tableY + 5.5)
    pdf.text('UNIT WT', 108, tableY + 5.5, { align: 'right' })
    pdf.text('QTY', 128, tableY + 5.5, { align: 'right' })
    pdf.text('TOTAL WT', 156, tableY + 5.5, { align: 'right' })
    pdf.text('REMARKS', 162, tableY + 5.5)
  }

  // Draw Page 1 background, header, and table header
  const tableStartY = isManufacturer ? 34 : 59
  drawPageBackground(pdf)
  drawHeader(12)
  drawTableColumnHeader(tableStartY)

  let y = isManufacturer ? 42 : 67
  const rowHeight = 22

  for (let index = 0; index < order.items.length; index++) {
    const item = order.items[index]
    const imgData = itemImages[index]

    // Check if new page needed
    if (y + rowHeight > 265) {
      pdf.addPage()
      drawPageBackground(pdf)
      drawTableColumnHeader(14)
      y = 22
    }

    // Row alternating background
    const isEven = index % 2 === 0
    pdf.setFillColor(isEven ? 16 : 10, isEven ? 13 : 8, isEven ? 9 : 6)
    pdf.rect(14, y, 182, rowHeight, 'F')

    // Bottom row line
    pdf.setDrawColor(50, 38, 25)
    pdf.line(14, y + rowHeight, 196, y + rowHeight)

    // 1. Serial Number
    pdf.setFontSize(8.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(166, 152, 136)
    pdf.text(String(item.serialNumber || index + 1), 18, y + 12)

    // 2. Embedded Thumbnail Image with Gold Border & Preserved Aspect Ratio (object-fit: contain)
    const boxX = 26
    const boxY = y + 2
    const boxW = 18
    const boxH = 18

    // Crisp white background backing tile
    pdf.setFillColor(255, 255, 255)
    pdf.rect(boxX, boxY, boxW, boxH, 'F')

    if (imgData) {
      try {
        const aspect = (imgData.width || 1) / (imgData.height || 1)
        let renderW = boxW
        let renderH = boxW / aspect
        if (renderH > boxH) {
          renderH = boxH
          renderW = boxH * aspect
        }

        // Center perfectly within the 18x18 cell without any distortion or stretching
        const imgX = boxX + (boxW - renderW) / 2
        const imgY = boxY + (boxH - renderH) / 2

        pdf.addImage(imgData.dataUrl, imgData.format, imgX, imgY, renderW, renderH, undefined, 'FAST')
      } catch (err) {
        console.warn('Failed to render item thumbnail:', err)
      }
    } else {
      pdf.setFontSize(6)
      pdf.setTextColor(180, 170, 160)
      pdf.text('No Image', boxX + boxW / 2, boxY + boxH / 2 + 1, { align: 'center' })
    }

    // Outer luxury gold border
    pdf.setDrawColor(212, 160, 58)
    pdf.rect(boxX, boxY, boxW, boxH, 'D')

    // 3. Design Code & Category
    pdf.setFontSize(9.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(255, 217, 119) // Gold
    pdf.text(item.designCode, 54, y + 9)

    pdf.setFontSize(7.5)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(180, 168, 152) // Champagne
    const catText = `${item.category || ''}${item.subcategory ? ' · ' + item.subcategory : ''}`
    const catDisplay = pdf.splitTextToSize(catText || 'Fine Jewelry', 35)[0] || catText || 'Fine Jewelry'
    pdf.text(catDisplay, 54, y + 14.5)

    // 4. Unit Weight in grams
    pdf.setFontSize(8.5)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(255, 255, 255)
    pdf.text(`${grams(item.weightMg)} g`, 108, y + 12, { align: 'right' })

    // 5. Quantity in pcs
    pdf.setFontSize(8.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(255, 255, 255)
    pdf.text(`${item.quantity} pcs`, 128, y + 12, { align: 'right' })

    // 6. Total Weight (Unit Weight * Quantity)
    const itemTotalWeightMg = (item.weightMg || 0) * (item.quantity || 1)
    pdf.setFontSize(8.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(255, 217, 119) // Gold
    pdf.text(`${grams(itemTotalWeightMg)} g`, 156, y + 12, { align: 'right' })

    // 7. Remarks
    pdf.setFontSize(7.5)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(190, 180, 165)
    const remarkLines = pdf.splitTextToSize(item.remark || '—', 32)
    pdf.text(remarkLines, 162, y + 9)

    y += rowHeight
  }

  // Totals Summary Box
  const totalQuantity = order.items.reduce((n, i) => n + i.quantity, 0)
  const totalWeightMg = order.items.reduce((n, i) => n + i.weightMg * i.quantity, 0)

  if (y + 32 > 265) {
    pdf.addPage()
    drawPageBackground(pdf)
    y = 16
  }

  y += 5
  pdf.setFillColor(18, 14, 10)
  pdf.setDrawColor(212, 160, 58)
  pdf.roundedRect(14, y, 182, 24, 2, 2, 'FD')

  // Golden left bar on summary box
  pdf.setFillColor(212, 160, 58)
  pdf.rect(14, y, 3, 24, 'F')

  pdf.setFontSize(7.5)
  pdf.setFont('helvetica', 'bold')
  pdf.setTextColor(212, 160, 58)
  pdf.text('FINAL ORDER SUMMARY & CERTIFICATION', 21, y + 6)

  pdf.setFontSize(10)
  pdf.setFont('helvetica', 'bold')
  pdf.setTextColor(255, 255, 255)
  pdf.text(`Designs: ${order.items.length}`, 21, y + 14)
  pdf.text(`Total Pieces: ${totalQuantity} pcs`, 76, y + 14)

  pdf.setTextColor(255, 217, 119)
  pdf.text(`Total Gross Weight: ${grams(totalWeightMg)} g`, 130, y + 14)

  pdf.setFontSize(7)
  pdf.setFont('helvetica', 'normal')
  pdf.setTextColor(166, 152, 136)
  pdf.text(`Authorized by ${order.salesperson || 'Salesperson'} on ${orderDate.toLocaleString()}. Retained on local device.`, 21, y + 20)

  // Number all pages cleanly with gold accents
  const totalPages = pdf.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i)
    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(166, 152, 136)
    const copyLabel = isManufacturer ? 'Manufacturer Production Sheet (Vendor Redacted)' : 'Client Order Sheet'
    pdf.text(`Shine Jewels · Order #${String(order.orderNumber).padStart(4, '0')} · ${copyLabel}`, 14, 290)
    pdf.text(`Page ${i} of ${totalPages}`, 196, 290, { align: 'right' })
  }

  // Exact filename format: Vendor_Name_DD-MM-YYYY_0001_CLIENT.pdf or _MANUFACTURER.pdf
  const copySuffix = isManufacturer ? 'MANUFACTURER' : 'CLIENT'
  const fileName = `${order.vendor.name.replace(/\s+/g, '_')}_${formatFileDate(orderDate)}_${String(order.orderNumber).padStart(4, '0')}_${copySuffix}.pdf`

  const pdfBlob = pdf.output('blob')
  const blobUrl = URL.createObjectURL(pdfBlob)

  return {
    blob: pdfBlob,
    blobUrl,
    fileName,
    order,
    totalQuantity,
    totalWeightMg,
    copyType: isManufacturer ? 'manufacturer' : 'client',
  }
}

export interface OrderPdfsResult {
  client: GeneratedPdfResult
  manufacturer: GeneratedPdfResult
}

export async function createBothOrderPdfs(rawOrder: Order): Promise<OrderPdfsResult> {
  const [client, manufacturer] = await Promise.all([
    createOrderPdfBlob(rawOrder, { copyType: 'client' }),
    createOrderPdfBlob(rawOrder, { copyType: 'manufacturer' }),
  ])
  return { client, manufacturer }
}

async function resolveHighResImageForDemo(product: Product): Promise<{ dataUrl: string; width: number; height: number; format: 'PNG' | 'JPEG' } | null> {
  try {
    let source: string | null = null

    // 1. Direct local OPFS / memory cache lookup for high-resolution detail image
    const detailKeys = [
      `${product.id}-detail-v${product.imageVersion || 1}`,
      product.detailImageKey,
      product.detailImage,
    ]
    for (const key of detailKeys) {
      if (key && !key.startsWith('http://') && !key.startsWith('https://')) {
        if (key.startsWith('data:')) {
          source = key
          break
        }
        const cached = await storage.getImage(key).catch(() => null)
        if (cached) {
          source = cached
          break
        }
      }
    }

    // 2. Try storage.resolveDetailImage
    if (!source) {
      const resolved = await storage.resolveDetailImage(product).catch(() => '')
      if (resolved) {
        if (resolved.startsWith('data:')) {
          source = resolved
        } else if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
          // If online, fetch or check if already cached
          const fetched = await urlToDataUrl(resolved).catch(() => null)
          if (fetched) {
            source = fetched
            // Cache locally so all future generations are 100% offline
            void storage.saveImageData(`${product.id}-detail-v${product.imageVersion || 1}`, fetched).catch(() => {})
          }
        } else {
          const cached = await storage.getImage(resolved).catch(() => null)
          if (cached) source = cached
        }
      }
    }

    // 3. Offline fallback to locally cached gridImage if detail image is not yet cached
    if (!source) {
      const gridKeys = [
        `${product.id}-grid-v${product.imageVersion || 1}`,
        product.gridImageKey,
        product.gridImage,
      ]
      for (const key of gridKeys) {
        if (key && !key.startsWith('http://') && !key.startsWith('https://')) {
          if (key.startsWith('data:')) {
            source = key
            break
          }
          const cached = await storage.getImage(key).catch(() => null)
          if (cached) {
            source = cached
            break
          }
        }
      }
      if (!source && product.gridImage) {
        if (product.gridImage.startsWith('data:')) {
          source = product.gridImage
        } else if (product.gridImage.startsWith('http://') || product.gridImage.startsWith('https://')) {
          const fetched = await urlToDataUrl(product.gridImage).catch(() => null)
          if (fetched) source = fetched
        }
      }
    }

    if (!source) return null

    return new Promise((resolve) => {
      const img = new Image()
      if (source!.startsWith('http://') || source!.startsWith('https://')) {
        img.crossOrigin = 'anonymous'
      }
      img.onload = () => {
        try {
          const w = img.naturalWidth || 800
          const h = img.naturalHeight || 800
          const format: 'PNG' | 'JPEG' = source!.startsWith('data:image/png') ? 'PNG' : 'JPEG'
          if (source!.startsWith('data:image/')) {
            resolve({ dataUrl: source!, width: w, height: h, format })
            return
          }
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            resolve(null)
            return
          }
          ctx.drawImage(img, 0, 0, w, h)
          resolve({
            dataUrl: canvas.toDataURL('image/jpeg', 0.92),
            width: w,
            height: h,
            format: 'JPEG',
          })
        } catch {
          resolve(null)
        }
      }
      img.onerror = () => resolve(null)
      img.src = source!
    })
  } catch {
    return null
  }
}

export async function createSalesDemoPdfBlob(
  products: Product[],
  categories: Category[],
  subcategories: Subcategory[],
  onProgress?: (current: number, total: number) => void
): Promise<GeneratedPdfResult> {
  if (!products.length) {
    throw new Error('Please select at least one design to generate a Sales Demo PDF.')
  }

  const [watermarkDataUrl, headerLogoDataUrl] = await Promise.all([
    getLogoWatermarkDataUrl(),
    getHeaderLogoBadgeDataUrl(),
  ])

  const pdf = new jsPDF({ unit: 'mm', format: 'a4' })

  const drawPageBackground = (p: jsPDF) => {
    p.setFillColor(8, 7, 5)
    p.rect(0, 0, 210, 297, 'F')

    if (watermarkDataUrl) {
      try {
        p.addImage(watermarkDataUrl, 'PNG', 35, 75, 140, 140, undefined, 'FAST')
      } catch {
        // non-blocking
      }
    }
  }

  for (let index = 0; index < products.length; index++) {
    const product = products[index]
    onProgress?.(index + 1, products.length)

    if (index > 0) {
      pdf.addPage()
    }

    drawPageBackground(pdf)

    // Top Gold Rule Accent
    pdf.setFillColor(212, 160, 58)
    pdf.rect(14, 10, 182, 1.2, 'F')

    // Left Logo Badge
    if (headerLogoDataUrl) {
      try {
        pdf.addImage(headerLogoDataUrl, 'PNG', 14, 12.5, 14, 14)
      } catch {
        // non-blocking
      }
    }

    // Brand Text
    const brandTextX = headerLogoDataUrl ? 31 : 14
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(15)
    pdf.setTextColor(232, 184, 75)
    pdf.text('SHINE JEWELS', brandTextX, 18)

    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(240, 230, 210)
    pdf.text('WE BRING THE SPARKLE YOU MAKE IT SHINE', brandTextX, 22.5)

    // Right Showcase Badge
    pdf.setFillColor(18, 14, 10)
    pdf.setDrawColor(212, 160, 58)
    pdf.roundedRect(138, 12, 58, 13, 2, 2, 'FD')

    pdf.setFontSize(6.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(190, 145, 60)
    pdf.text('PRODUCT SHOWCASE', 142, 16.5)

    pdf.setFontSize(8.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(255, 217, 119)
    pdf.text(`DESIGN ${index + 1} OF ${products.length}`, 142, 21.5)

    // Central High-Resolution Showcase Frame
    const frameX = 14
    const frameY = 26
    const frameW = 182
    const frameH = 227

    pdf.setFillColor(12, 9, 7)
    pdf.setDrawColor(48, 36, 24)
    pdf.roundedRect(frameX, frameY, frameW, frameH, 3, 3, 'FD')

    pdf.setDrawColor(120, 90, 40)
    pdf.roundedRect(frameX + 1.5, frameY + 1.5, frameW - 3, frameH - 3, 2.5, 2.5, 'S')

    // High resolution image resolution
    const imgInfo = await resolveHighResImageForDemo(product)
    if (imgInfo) {
      try {
        const maxW = frameW - 8
        const maxH = frameH - 8
        const aspect = (imgInfo.width || 1) / (imgInfo.height || 1)

        let renderW = maxW
        let renderH = maxW / aspect
        if (renderH > maxH) {
          renderH = maxH
          renderW = maxH * aspect
        }

        const imgX = frameX + (frameW - renderW) / 2
        const imgY = frameY + (frameH - renderH) / 2

        pdf.addImage(imgInfo.dataUrl, imgInfo.format, imgX, imgY, renderW, renderH, undefined, 'FAST')
      } catch (err) {
        console.warn('Failed to render demo image:', err)
        pdf.setFontSize(11)
        pdf.setTextColor(212, 160, 58)
        pdf.text(`[High-Resolution Design: ${product.designCode}]`, 105, 130, { align: 'center' })
      }
    } else {
      pdf.setFontSize(11)
      pdf.setTextColor(212, 160, 58)
      pdf.text(`[High-Resolution Design: ${product.designCode}]`, 105, 130, { align: 'center' })
    }

    // Bottom Details Section (compact, sleek)
    const detY = 256
    const detH = 24

    pdf.setFillColor(18, 14, 10)
    pdf.setDrawColor(212, 160, 58)
    pdf.roundedRect(14, detY, 182, detH, 2, 2, 'FD')

    // Gold accent indicator
    pdf.setFillColor(212, 160, 58)
    pdf.rect(14, detY, 2.5, detH, 'F')

    // Column dividers
    pdf.setDrawColor(60, 45, 30)
    pdf.line(76, detY + 3.5, 76, detY + detH - 3.5)
    pdf.line(134, detY + 3.5, 134, detY + detH - 3.5)

    // Col 1: Design Code
    pdf.setFontSize(6)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(190, 145, 60)
    pdf.text('DESIGN CODE', 20, detY + 6.5)

    pdf.setFontSize(12.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(255, 255, 255)
    pdf.text(product.designCode, 20, detY + 14.5)

    pdf.setFontSize(6)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(180, 168, 152)
    pdf.text('Exclusive Shine Jewels Design', 20, detY + 19.5)

    // Col 2: Gross Weight
    pdf.setFontSize(6)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(190, 145, 60)
    pdf.text('GROSS WEIGHT', 80, detY + 6.5)

    pdf.setFontSize(11.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(255, 217, 119)
    pdf.text(`${grams(product.weightMg)} g`, 80, detY + 14.5)

    pdf.setFontSize(6)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(180, 168, 152)
    pdf.text(`Net: ${(product.weightMg / 1000).toFixed(3)} grams`, 80, detY + 19.5)

    // Col 3: Category & Subcategory
    const catName = categories.find(c => c.id === product.categoryId)?.name || 'Jewelry'
    const subName = subcategories.find(s => s.id === product.subcategoryId)?.name || 'Exclusive'

    pdf.setFontSize(6)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(190, 145, 60)
    pdf.text('CATEGORY & CLASSIFICATION', 138, detY + 6.5)

    pdf.setFontSize(10)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(255, 255, 255)
    pdf.text(pdf.splitTextToSize(catName, 52)[0] || catName, 138, detY + 14)

    pdf.setFontSize(7.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(232, 184, 75)
    pdf.text(pdf.splitTextToSize(subName, 52)[0] || subName, 138, detY + 19.5)

    // Page footer line
    pdf.setFontSize(6.5)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(150, 138, 125)
    pdf.text('Shine Jewels · Product Demo Presentation', 14, 289)
    pdf.text(`Page ${index + 1} of ${products.length}`, 196, 289, { align: 'right' })
  }

  const totalWeightMg = products.reduce((acc, p) => acc + p.weightMg, 0)
  const fileName = `Shine_Jewels_Demo_${formatFileDate(new Date())}_${products.length}_Designs.pdf`
  const pdfBlob = pdf.output('blob')
  const blobUrl = URL.createObjectURL(pdfBlob)

  return {
    blob: pdfBlob,
    blobUrl,
    fileName,
    totalQuantity: products.length,
    totalWeightMg,
    copyType: 'demo',
    itemCount: products.length,
  }
}

export function downloadPdfBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export async function sharePdfFile(
  blob: Blob,
  fileName: string,
  rawOrder?: Order,
  customTitle?: string,
  customText?: string
): Promise<boolean> {
  const pdfFile = new File([blob], fileName, { type: 'application/pdf' })
  let title = customTitle || fileName
  let text = customText || 'Shine Jewels PDF Document'

  if (rawOrder) {
    const order = normalizeOrderForPdf(rawOrder)
    const totalQuantity = order.items.reduce((n, i) => n + i.quantity, 0)
    const totalWeightMg = order.items.reduce((n, i) => n + i.weightMg * i.quantity, 0)
    title = title || `Order #${String(order.orderNumber).padStart(4, '0')} - ${order.vendor.name}`
    text = text || `Shine Jewels order #${String(order.orderNumber).padStart(4, '0')} for ${order.vendor.name}. ${totalQuantity} pcs, ${grams(totalWeightMg)} g.`
  }

  if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
    try {
      await navigator.share({
        files: [pdfFile],
        title,
        text,
      })
      return true
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return true
      }
      console.warn('Native share failed:', err)
    }
  }
  return false
}

export async function generateOrderPdf(order: Order): Promise<GeneratedPdfResult> {
  return createOrderPdfBlob(order)
}

