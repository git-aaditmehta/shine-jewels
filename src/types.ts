export type Role = 'ADMIN' | 'SALESPERSON'
export type VendorType = 'WHOLESALE' | 'RETAIL' | 'CORPORATE'
export type SyncState = 'PENDING_UPLOAD' | 'UPLOADING' | 'CLOUD_CONFIRMED' | 'LOCAL_CONFIRMED' | 'SYNCED' | 'ERROR'

export interface Category { id: string; name: string; active: boolean }
export interface Subcategory { id: string; categoryId: string; name: string; active: boolean }
export interface Product { id: string; designCode: string; categoryId: string; subcategoryId: string; weightMg: number; gridImage: string; detailImage: string; imageVersion: number; syncState: SyncState; deleted?: boolean; gridImageKey?: string; detailImageKey?: string; gridImageChecksum?: string; detailImageChecksum?: string; gridImageSizeBytes?: number; detailImageSizeBytes?: number }
export interface Vendor { id: string; name: string; address: string; city: string; type: VendorType; deleted?: boolean }
export interface OrderItem { productId: string; serialNumber: number; designCode: string; category: string; subcategory: string; weightMg: number; quantity: number; remark: string; image: string }
export interface VendorRepresentative { name: string; phone: string }
export interface Order { id: string; orderNumber?: number; vendor: Vendor; representatives?: VendorRepresentative[]; salesperson: string; status: 'DRAFT' | 'FINALIZED'; createdAt: string; generatedAt?: string; items: OrderItem[] }
export interface Session { userId: string; displayName: string; role: Role; organizationId: string; offlineAuthorizationExpiresAt: string }
