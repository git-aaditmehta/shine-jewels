# Shine Jewels: Updated Product Requirements Document (PRD)

> **Specification Status**: Updated v1.1 (Role Consolidation & Synchronization Specification)  
> **Source Baseline**: `jewelry_catalogue_prd_detailed.docx` & System Audit 2026-09-18

---

## 1. Product Summary & Core Principles
Shine Jewels is an iPad-first, mobile-compatible, offline-capable digital sales catalogue and manufacturer-order application for jewelry businesses.
- **Authoritative Cloud**: Cloudflare D1 (structured catalogue, accounts, order history) and Cloudflare R2 (optimized images).
- **Offline Replica**: iPad stores catalogue metadata in SQLite WASM + OPFS and images in OPFS filesystem.
- **Core Workflow**: Select Vendor $\rightarrow$ Browse / Filter Designs $\rightarrow$ Select Items $\rightarrow$ Enter Quantities & Remarks $\rightarrow$ Finalize Order $\rightarrow$ Generate PDF offline $\rightarrow$ Save to iPad Files / Share via native Sheet.
- **Non-Goals**: No stock deduction, no live inventory synchronization, no accounting/invoicing, no bulk CSV imports.

---

## 2. Updated Roles & Permissions Matrix

To simplify day-to-day sales operations, **all catalogue management, taxonomy, and order features are unified across both Salesperson and Admin**. Only device session governance and force logout are restricted to Admin.

| Capability | Admin | Salesperson | Implementation Notes |
| :--- | :---: | :---: | :--- |
| **Login & 30-day Offline Auth** | Yes | Yes | Hashed session in D1; valid offline up to 30 days. |
| **Catalogue Browse / Filter / Search** | Yes | Yes | Fast local SQLite WASM queries; works offline. |
| **Order Creation & Offline PDF** | Yes | Yes | Offline jsPDF generation with embedded design images. |
| **Order History Access** | Yes | Yes | Immutable snapshots of vendor, design, and weight. |
| **Vendor Management (Add / Archive)** | Yes | Yes | Normalized `name + city` uniqueness within organization. |
| **Taxonomy (Add / Archive Category & Subcat)**| Yes | Yes | Scoped to parent category; archive blocks if items active. |
| **Single Product Creation** | Yes | Yes | Validated design code, category/subcat, 0.001 g weight. |
| **Batch Product Entry** | Yes | Yes | Queued image workflow; preserves failed images on error. |
| **Product Image Replacement & Archival** | Yes | Yes | Replaces image key/version; soft-delete preserves history. |
| **Storage & Sync Recovery** | Yes | Yes | Manual & automated sync triggers; byte accounting. |
| **View Device Sessions** | **Yes** | **No** | Server-side 403 on `/devices` for Salesperson. |
| **Force Logout / Remote Revocation** | **Yes** | **No** | Server-side 403 on `/devices/:id/revoke` for Salesperson. |

---

## 3. Image Pipeline & Memory Requirements
1. **Dual Representation**:
   - **Grid Image**: 30–60 KB target where achievable without visible degradation. Used exclusively for virtualized catalogue browsing.
   - **Detail Image**: High-resolution, inspection-grade asset. Stored locally for offline swipe/modal inspection.
2. **Aspect Ratio**: Must preserve aspect ratio; no stretching, distortion, or forced square cropping.
3. **Memory Bounding**: Grid **must be virtualized**. Only visible and near-visible cards are decoded in DOM / RAM. Never decode all 10,000 images into memory simultaneously.

---

## 4. Synchronization Contract
1. **Initial Bootstrap**: Downloads all active categories, subcategories, vendors, products, and finalized order headers from D1. Sets local checkpoint to max sequence number.
2. **Incremental Sync**: Polling or reconnect queries `/sync/changes?after={checkpoint}` and applies changes sequentially.
3. **Offline Mutation Queue**: Local writes (vendors, products, orders, categories) queue in SQLite `pending_operations` and dispatch idempotently upon reconnection.
4. **Integrity Validation**: SHA-256 checksum and exact byte size verified upon download and upload.
5. **Image Recovery**: Missing local OPFS images are re-fetched directly from Cloudflare R2 using recovery endpoints.
6. **Soft-Delete Propagation**: Remotely archived products or vendors are marked soft-deleted locally (`deleted = 1`) without breaking historical order snapshots.
