# Shine Jewels: Updated Architecture Specification

> **Specification Status**: Updated v1.1 (Role Consolidation & Synchronization Specification)  
> **Source Baseline**: `jewelry_catalogue_architecture_document_final (1).docx` & System Audit 2026-09-18

---

## 1. System Topology

```
+-------------------------------------------------------------------------------+
|                               CLOUDFLARE CLOUD                                |
|                                                                               |
|   +-------------------+     +--------------------+    +--------------------+  |
|   |   Cloudflare D1   |     |   Cloudflare R2    |    |    Google Drive    |  |
|   |  Authoritative DB |     | Optimized Images   |    |  Disaster Backup   |  |
|   |  Metadata/History |     | Public Object URLs |    |  (High-Res Only)   |  |
|   +---------^---------+     +---------^----------+    +--------------------+  |
|             |                         |                                       |
|             +------------+            | Direct image upload/download          |
|                          |            | (Worker never proxies image bytes)    |
|   +----------------------v------------v-----------------------------------+   |
|   |                         Cloudflare Worker                             |   |
|   |               API / Auth / Validation / Sync Engine                   |   |
|   +-----------------------------------^-----------------------------------+   |
+---------------------------------------|---------------------------------------+
                                        | JSON API over HTTPS
+---------------------------------------v---------------------------------------+
|                                  iPAD CLIENT                                  |
|                                                                               |
|   +-----------------------------------------------------------------------+   |
|   |                               React PWA                               |   |
|   |   Virtualized Grid (Bounded RAM)  |  Offline Order & PDF Generator    |   |
|   +-----------------------------------^-----------------------------------+   |
|                                       |                                       |
|   +-----------------------------------v-----------------------------------+   |
|   |                        Local Storage Subsystem                        |   |
|   |   SQLite WASM (oo1.OpfsDb)        |  OPFS File System (shine-jewels)  |   |
|   |   Metadata, Sync Queue, Snapshots |  Grid & High-Res Image Files      |   |
|   +-----------------------------------------------------------------------+   |
+-------------------------------------------------------------------------------+
```

---

## 2. Updated Security & Role Architecture

- **Authentication**: Organization-scoped individual accounts with PBKDF2-SHA256 password hashing.
- **Offline Authorization**: Successful online authentication grants a 30-day cryptographically hashed device session stored locally in SQLite WASM. Reconnecting automatically refreshes authorization.
- **Role Model**:
  - **Shared Business Capabilities** (Admin & Salesperson): Full browsing, search, filter, order finalization, offline PDF generation, vendor creation/archival, category/subcategory taxonomy, single product entry, batch product entry, image replacement, and storage sync/recovery.
  - **Admin-Only Security Capabilities**:
    - Querying registered device sessions (`GET /devices`).
    - Revoking device sessions / force logout (`POST /devices/:id/revoke`).
  - **Server-Side Enforcement**: All restricted endpoints reject non-Admin callers with `403 Forbidden` at the Cloudflare Worker layer.

---

## 3. Comprehensive Synchronization Protocol

1. **Bootstrap (`GET /sync/bootstrap`)**:
   - Downloads all active categories, subcategories, vendors, and products.
   - Saves records into local SQLite WASM replica.
   - Records current maximum change sequence number as `sync_checkpoint`.
2. **Incremental Catch-Up (`GET /sync/changes?after={checkpoint}`)**:
   - Returns array of change items (`CREATE`, `UPDATE`, `ARCHIVE`, `FINALIZE`).
   - Dispatches changes to local SQLite tables and advances `sync_checkpoint`.
3. **Offline Mutation Queue**:
   - Any local write staged while offline creates an entry in `pending_operations` table with a unique idempotency key.
   - When online, operations are pushed in order. Failed attempts increment retry count and retain state for subsequent passes.
4. **Integrity & Checksum Verification**:
   - Each product image includes `checksum` (SHA-256) and `size_bytes`.
   - On download, SHA-256 is verified before marking image as local replica.
5. **Missing Image Recovery (`GET /images/:key/recovery`)**:
   - If a local image file is deleted or corrupt in OPFS, the sync layer queries recovery metadata and downloads the authorized asset directly from R2.
