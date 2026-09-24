import type { Order, Product, Vendor } from './types'
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

async function convertToWhiteBackedJpeg(source: string): Promise<string | null> {
  if (!source) return null
  let src = source

  if (src.startsWith('http://') || src.startsWith('https://')) {
    const fetched = await urlToDataUrl(src)
    if (fetched) {
      src = fetched
    }
  }

  // If already clean JPEG data URL, we can return it directly or draw onto canvas
  if (src.startsWith('data:image/jpeg')) {
    return src
  }

  return new Promise((resolve) => {
    const img = new Image()
    if (src.startsWith('http://') || src.startsWith('https://')) {
      img.crossOrigin = 'anonymous'
    }
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || 300
        canvas.height = img.naturalHeight || 300
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(src.startsWith('data:') ? src : null)
          return
        }
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.88))
      } catch {
        resolve(src.startsWith('data:') ? src : null)
      }
    }
    img.onerror = () => {
      resolve(src.startsWith('data:') ? src : null)
    }
    img.src = src
  })
}

async function resolveItemThumbnail(
  item: Order['items'][number],
  localProducts: Product[]
): Promise<string | null> {
  // 1. Direct item.image snapshot if present and already a data URL
  if (item.image && item.image.startsWith('data:')) {
    const res = await convertToWhiteBackedJpeg(item.image)
    if (res) return res
  }

  // 2. If item.image is a local path / key (not http and not data)
  if (item.image && !item.image.startsWith('http://') && !item.image.startsWith('https://')) {
    const cached = await storage.getImage(item.image)
    if (cached) {
      const res = await convertToWhiteBackedJpeg(cached)
      if (res) return res
    }
  }

  // 3. Find matching product in local database by productId or designCode
  const prod = localProducts.find(
    p => (item.productId && p.id === item.productId) ||
         (item.designCode && p.designCode.trim().toLowerCase() === item.designCode.trim().toLowerCase())
  )

  if (prod) {
    // 3a. If prod has a grid or detail image as data URL
    if (prod.gridImage && prod.gridImage.startsWith('data:')) {
      const res = await convertToWhiteBackedJpeg(prod.gridImage)
      if (res) return res
    }
    if (prod.detailImage && prod.detailImage.startsWith('data:')) {
      const res = await convertToWhiteBackedJpeg(prod.detailImage)
      if (res) return res
    }

    // 3b. Try OPFS key lookups for this product
    const keysToTry = [
      `${prod.id}-grid-v${prod.imageVersion || 1}`,
      `${prod.id}-detail-v${prod.imageVersion || 1}`,
      prod.gridImage,
      prod.detailImage
    ]
    for (const key of keysToTry) {
      if (key && !key.startsWith('http://') && !key.startsWith('https://') && !key.startsWith('data:')) {
        const cached = await storage.getImage(key)
        if (cached) {
          const res = await convertToWhiteBackedJpeg(cached)
          if (res) return res
        }
      }
    }

    // 3c. Try HTTP URLs from prod
    if (prod.gridImage && (prod.gridImage.startsWith('http://') || prod.gridImage.startsWith('https://'))) {
      const res = await convertToWhiteBackedJpeg(prod.gridImage)
      if (res) {
        // Cache locally for instant future generations
        void storage.saveImageData(`${prod.id}-grid-v${prod.imageVersion || 1}`, res)
        return res
      }
    }
  }

  // 4. If item.image itself was an HTTP URL
  if (item.image && (item.image.startsWith('http://') || item.image.startsWith('https://'))) {
    const res = await convertToWhiteBackedJpeg(item.image)
    if (res) return res
  }

  return null
}

export interface GeneratedPdfResult {
  blob: Blob
  blobUrl: string
  fileName: string
  order: Order
  totalQuantity: number
  totalWeightMg: number
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

export async function createOrderPdfBlob(rawOrder: Order): Promise<GeneratedPdfResult> {
  const order = normalizeOrderForPdf(rawOrder)
  if (!order.orderNumber) throw new Error('An order number is required before PDF generation.')

  // Resolve all images concurrently before laying out PDF
  const localProducts = await storage.products().catch(() => [])
  const itemImages = await Promise.all(
    order.items.map(item => resolveItemThumbnail(item, localProducts))
  )

  const pdf = new jsPDF({ unit: 'mm', format: 'a4' })
  const orderDate = new Date(order.generatedAt || order.createdAt || Date.now())

  const drawHeader = (startY: number) => {
    // Elegant gold top accent line
    pdf.setFillColor(169, 119, 43)
    pdf.rect(14, startY, 182, 1.5, 'F')

    // Company branding
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(18)
    pdf.setTextColor(23, 35, 30)
    pdf.text('SHINE JEWELS', 14, startY + 9)

    pdf.setFontSize(8)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(169, 119, 43)
    pdf.text('FINE JEWELRY MANUFACTURER ORDER SHEET', 14, startY + 14)

    // Order number badge (top right)
    pdf.setFillColor(247, 245, 239)
    pdf.setDrawColor(169, 119, 43)
    pdf.roundedRect(144, startY + 3, 52, 13, 2, 2, 'FD')

    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(102, 112, 105)
    pdf.text('ORDER NUMBER', 147, startY + 7.5)

    pdf.setFontSize(12)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(23, 35, 30)
    pdf.text(`#${String(order.orderNumber).padStart(4, '0')}`, 147, startY + 13)

    // Vendor, Vendor Representative, and Order metadata card
    const cardHeight = 25
    pdf.setFillColor(255, 253, 248)
    pdf.setDrawColor(217, 216, 207)
    pdf.roundedRect(14, startY + 18, 182, cardHeight, 2, 2, 'FD')

    // Vertical dividers between the 3 sections
    pdf.setDrawColor(230, 228, 220)
    pdf.line(80, startY + 20, 80, startY + 18 + cardHeight - 2)
    pdf.line(138, startY + 20, 138, startY + 18 + cardHeight - 2)

    // 1. Vendor info (Col 1: 14 to 80 mm)
    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(169, 119, 43)
    pdf.text('VENDOR INFORMATION', 17, startY + 23)

    pdf.setFontSize(10)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(23, 35, 30)
    const vendorNameDisplay = pdf.splitTextToSize(order.vendor.name, 60)[0] || order.vendor.name
    pdf.text(vendorNameDisplay, 17, startY + 28)

    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(102, 112, 105)
    const vendorAddrLine = `${order.vendor.address}, ${order.vendor.city}`
    const splitAddr = pdf.splitTextToSize(vendorAddrLine, 60)
    pdf.text(splitAddr[0] || vendorAddrLine, 17, startY + 33)
    pdf.text(`Type: ${order.vendor.type}`, 17, startY + 37.5)

    // 2. Vendor Representative(s) (Col 2: 80 to 138 mm)
    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(169, 119, 43)
    pdf.text('VENDOR REPRESENTATIVE', 83, startY + 23)

    const reps = (order.representatives || []).filter(r => (r.name && r.name.trim()) || (r.phone && r.phone.trim()))
    if (reps.length === 0) {
      pdf.setFontSize(8)
      pdf.setFont('helvetica', 'normal')
      pdf.setTextColor(102, 112, 105)
      pdf.text('—', 83, startY + 29)
    } else if (reps.length === 1) {
      const rep = reps[0]
      pdf.setFontSize(9)
      pdf.setFont('helvetica', 'bold')
      pdf.setTextColor(23, 35, 30)
      pdf.text(rep.name.trim() || '—', 83, startY + 28)

      pdf.setFontSize(7.5)
      pdf.setFont('helvetica', 'normal')
      pdf.setTextColor(102, 112, 105)
      pdf.text(rep.phone.trim() ? `Tel: ${rep.phone.trim()}` : '—', 83, startY + 33.5)
    } else {
      // Multiple representatives
      let repY = startY + 27.5
      reps.slice(0, 3).forEach((rep) => {
        pdf.setFontSize(7.5)
        pdf.setFont('helvetica', 'bold')
        pdf.setTextColor(23, 35, 30)
        const repNameText = rep.name.trim() || '—'
        const repPhoneText = rep.phone.trim() ? ` (${rep.phone.trim()})` : ''
        const fullRepText = pdf.splitTextToSize(`${repNameText}${repPhoneText}`, 53)[0] || `${repNameText}${repPhoneText}`
        pdf.text(`• ${fullRepText}`, 83, repY)
        repY += 4.5
      })
      if (reps.length > 3) {
        pdf.setFontSize(6.5)
        pdf.setFont('helvetica', 'italic')
        pdf.setTextColor(102, 112, 105)
        pdf.text(`+${reps.length - 3} more`, 83, repY)
      }
    }

    // 3. Order Details (Col 3: 138 to 196 mm)
    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(169, 119, 43)
    pdf.text('ORDER DETAILS', 141, startY + 23)

    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(23, 35, 30)
    pdf.text(`Date: ${orderDate.toLocaleDateString('en-GB')}`, 141, startY + 28)
    pdf.text(`Time: ${orderDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 141, startY + 32.5)
    pdf.text(`Sales Rep: ${order.salesperson || 'Salesperson'}`, 141, startY + 37)
  }

  const drawTableColumnHeader = (tableY: number) => {
    pdf.setFillColor(23, 35, 30)
    pdf.rect(14, tableY, 182, 8, 'F')

    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(255, 255, 255)
    pdf.text('#', 17, tableY + 5.5)
    pdf.text('PREVIEW', 27, tableY + 5.5)
    pdf.text('DESIGN DETAILS', 54, tableY + 5.5)
    pdf.text('UNIT WT', 108, tableY + 5.5, { align: 'right' })
    pdf.text('QTY', 128, tableY + 5.5, { align: 'right' })
    pdf.text('TOTAL WT', 156, tableY + 5.5, { align: 'right' })
    pdf.text('REMARKS', 162, tableY + 5.5)
  }

  // Draw Page 1 header
  drawHeader(12)
  drawTableColumnHeader(58)

  let y = 66
  const rowHeight = 22

  for (let index = 0; index < order.items.length; index++) {
    const item = order.items[index]
    const imgData = itemImages[index]

    // Check if new page needed
    if (y + rowHeight > 265) {
      pdf.addPage()
      drawTableColumnHeader(14)
      y = 22
    }

    // Row alternating background
    const isEven = index % 2 === 0
    pdf.setFillColor(isEven ? 255 : 252, isEven ? 255 : 251, isEven ? 255 : 249)
    pdf.rect(14, y, 182, rowHeight, 'F')

    // Bottom row line
    pdf.setDrawColor(229, 227, 220)
    pdf.line(14, y + rowHeight, 196, y + rowHeight)

    // 1. Serial Number
    pdf.setFontSize(8.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(102, 112, 105)
    pdf.text(String(item.serialNumber || index + 1), 18, y + 12)

    // 2. Embedded Thumbnail Image
    if (imgData) {
      try {
        pdf.addImage(imgData, 'JPEG', 26, y + 2, 18, 18)
        pdf.setDrawColor(217, 216, 207)
        pdf.rect(26, y + 2, 18, 18, 'D')
      } catch {
        pdf.setFillColor(242, 240, 235)
        pdf.rect(26, y + 2, 18, 18, 'F')
        pdf.setFontSize(6)
        pdf.setTextColor(150, 150, 150)
        pdf.text('Image', 31, y + 11)
      }
    } else {
      pdf.setFillColor(242, 240, 235)
      pdf.rect(26, y + 2, 18, 18, 'F')
      pdf.setFontSize(6)
      pdf.setTextColor(150, 150, 150)
      pdf.text('Image', 31, y + 11)
    }

    // 3. Design Code & Category
    pdf.setFontSize(9.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(23, 35, 30)
    pdf.text(item.designCode, 54, y + 9)

    pdf.setFontSize(7.5)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(102, 112, 105)
    const catText = `${item.category || ''}${item.subcategory ? ' · ' + item.subcategory : ''}`
    const catDisplay = pdf.splitTextToSize(catText || 'Fine Jewelry', 35)[0] || catText || 'Fine Jewelry'
    pdf.text(catDisplay, 54, y + 14.5)

    // 4. Unit Weight in grams
    pdf.setFontSize(8.5)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(23, 35, 30)
    pdf.text(`${grams(item.weightMg)} g`, 108, y + 12, { align: 'right' })

    // 5. Quantity in pcs
    pdf.setFontSize(8.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(23, 35, 30)
    pdf.text(`${item.quantity} pcs`, 128, y + 12, { align: 'right' })

    // 6. Total Weight (Unit Weight * Quantity)
    const itemTotalWeightMg = (item.weightMg || 0) * (item.quantity || 1)
    pdf.setFontSize(8.5)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(169, 119, 43)
    pdf.text(`${grams(itemTotalWeightMg)} g`, 156, y + 12, { align: 'right' })

    // 7. Remarks
    pdf.setFontSize(7.5)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(102, 112, 105)
    const remarkLines = pdf.splitTextToSize(item.remark || '—', 32)
    pdf.text(remarkLines, 162, y + 9)

    y += rowHeight
  }

  // Totals Summary Box
  const totalQuantity = order.items.reduce((n, i) => n + i.quantity, 0)
  const totalWeightMg = order.items.reduce((n, i) => n + i.weightMg * i.quantity, 0)

  if (y + 32 > 265) {
    pdf.addPage()
    y = 16
  }

  y += 5
  pdf.setFillColor(247, 245, 239)
  pdf.setDrawColor(169, 119, 43)
  pdf.roundedRect(14, y, 182, 24, 2, 2, 'FD')

  // Golden left bar on summary box
  pdf.setFillColor(169, 119, 43)
  pdf.rect(14, y, 3, 24, 'F')

  pdf.setFontSize(7.5)
  pdf.setFont('helvetica', 'bold')
  pdf.setTextColor(169, 119, 43)
  pdf.text('FINAL ORDER SUMMARY & CERTIFICATION', 21, y + 6)

  pdf.setFontSize(10)
  pdf.setFont('helvetica', 'bold')
  pdf.setTextColor(23, 35, 30)
  pdf.text(`Designs: ${order.items.length}`, 21, y + 14)
  pdf.text(`Total Pieces: ${totalQuantity} pcs`, 76, y + 14)
  pdf.text(`Total Gross Weight: ${grams(totalWeightMg)} g`, 130, y + 14)

  pdf.setFontSize(7)
  pdf.setFont('helvetica', 'normal')
  pdf.setTextColor(102, 112, 105)
  pdf.text(`Authorized by ${order.salesperson || 'Salesperson'} on ${orderDate.toLocaleString()}. Retained on local device.`, 21, y + 20)

  // Number all pages cleanly
  const totalPages = pdf.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i)
    pdf.setFontSize(7)
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(120, 130, 125)
    pdf.text(`Shine Jewels · Order #${String(order.orderNumber).padStart(4, '0')} · Confidential Manufacturer Sheet`, 14, 290)
    pdf.text(`Page ${i} of ${totalPages}`, 196, 290, { align: 'right' })
  }

  // Exact filename format: Vendor_Name_DD-MM-YYYY_0001.pdf
  const fileName = `${order.vendor.name.replace(/\s+/g, '_')}_${formatFileDate(orderDate)}_${String(order.orderNumber).padStart(4, '0')}.pdf`

  const pdfBlob = pdf.output('blob')
  const blobUrl = URL.createObjectURL(pdfBlob)

  return {
    blob: pdfBlob,
    blobUrl,
    fileName,
    order,
    totalQuantity,
    totalWeightMg,
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

export async function sharePdfFile(blob: Blob, fileName: string, rawOrder: Order): Promise<boolean> {
  const order = normalizeOrderForPdf(rawOrder)
  const pdfFile = new File([blob], fileName, { type: 'application/pdf' })
  const totalQuantity = order.items.reduce((n, i) => n + i.quantity, 0)
  const totalWeightMg = order.items.reduce((n, i) => n + i.weightMg * i.quantity, 0)

  if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
    try {
      await navigator.share({
        files: [pdfFile],
        title: `Order #${String(order.orderNumber).padStart(4, '0')} - ${order.vendor.name}`,
        text: `Shine Jewels order #${String(order.orderNumber).padStart(4, '0')} for ${order.vendor.name}. ${totalQuantity} pcs, ${grams(totalWeightMg)} g.`,
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
