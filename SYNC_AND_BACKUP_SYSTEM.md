# Universal Sync & Backup/Restore Architecture for Client-Side Web Apps

A comprehensive technical guide for implementing a robust, serverless, encrypted sync and backup/restore system in single-page web applications (SPAs).

This architecture enables:
1. **100% Client-Side & Serverless**: No backend servers, databases, or cloud accounts required.
2. **Encrypted at Rest**: AES-GCM encryption with SHA-256 derived keys for casual privacy.
3. **Interchangeable Files**: The Sync file and the Backup file share the exact same schema, format, and encryption. A backup can be used as a sync file, and a sync file can be restored as a backup.
4. **Multi-Browser & Cross-OS Resilience**:
   - **Chromium (Chrome, Arc, Edge)**: 1-click persistent file sync via the File System Access API (retaining handles across sessions in IndexedDB).
   - **Non-FSA Browsers (Safari, Firefox, Brave, iOS, Android)**: Seamless fallback via `<input type="file">`, Web Share API, and download streams.
   - **Cross-Platform Safety**: Resilient against Windows UTF-8 BOM markers, line ending variations (`\r\n` vs `\n`), and base64 whitespace formatting.
5. **Conflict Resolution & Fingerprinting**: Automatic 3-way synchronization logic with visual difference comparison.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Envelope & Encryption Format](#2-data-envelope--encryption-format)
3. [Unified Data Schema](#3-unified-data-schema)
4. [Change Detection & Fast Hashing](#4-change-detection--fast-hashing)
5. [Storage: Storing File Handles in IndexedDB](#5-storage-storing-file-handles-in-indexeddb)
6. [The Sync Decision Engine](#6-the-sync-decision-engine)
7. [Fingerprinting & Difference Engine](#7-fingerprinting--difference-engine)
8. [Backup & Restore Flow](#8-backup--restore-flow)
9. [Cross-Browser & Platform Quirks](#9-cross-browser--platform-quirks)
10. [Reference Implementation (Copy-Paste Modules)](#10-reference-implementation)

---

## 1. Architecture Overview

```
                      +-----------------------------+
                      |   App State (localStorage)  |
                      +--------------+--------------+
                                     |
                         [ noteLocalChange() ]
                                     |
                                     v
                       +---------------------------+
                       | Fast Hash Sync (DJB2/CRC) |
                       +---------------------------+
                                     |
                         [ User clicks "Sync" ]
                                     |
         +---------------------------+---------------------------+
         |                                                       |
 [FSA Supported: Chrome/Arc]                           [Fallback: Safari/Firefox]
         |                                                       |
  getSyncHandle() from IndexedDB                         Open <input type="file">
         |                                                       |
readSyncFile(handle)                                   read file from event
         |                                                       |
         +---------------------------+---------------------------+
                                     |
                                     v
                         [ parseExport() Decrypt ]
                                     |
                                     v
                    [ executeSyncResolution() Engine ]
                                     |
         +---------------------------+---------------------------+
         |                           |                           |
    [Identical]               [One-Way Pull/Push]        [True Conflict]
         |                           |                           |
  Mark in-sync                Auto-update data         openSyncConflictModal()
```

---

## 2. Data Envelope & Encryption Format

All files exported or written to disk use a standardized JSON wrapper containing AES-GCM encrypted data.

### 2.1 Envelope Format

```json
{
  "format": "app-name-encrypted-v1",
  "iv": "X+qflpP2APuoG9SL",
  "data": "a3FkOWZqODNmY..."
}
```

* **`format`**: Marker string identifying the encryption version.
* **`iv`**: 12-byte initialization vector, generated randomly per save, Base64-encoded.
* **`data`**: AES-GCM ciphertext with the 16-byte authentication tag appended, Base64-encoded.

### 2.2 Key Derivation & Web Crypto

The encryption key is derived by running SHA-256 over an application passkey or user-provided passphrase:

```javascript
const EXPORT_KEY = "YourApp export key v1 - casual privacy only";
const EXPORT_MARKER = "app-name-encrypted-v1";

async function getCryptoKey(usage) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(EXPORT_KEY));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [usage]);
}
```

### 2.3 Robust Base64 Encoding & Decoding

> [!IMPORTANT]
> Never use `String.fromCharCode(...bytes)` on large buffers because it exceeds the JavaScript call-stack limit (often 65,536 arguments). Never call `atob()` directly without stripping whitespace, as line breaks or spaces from clipboard transfers or text editors will throw `InvalidCharacterError`.

```javascript
function encodeExportBytes(bytes) {
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function decodeExportBytes(value) {
  const cleanB64 = (value || "").replace(/\s+/g, "");
  const binary = atob(cleanB64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
```

### 2.4 Decryption with Fallback & BOM Stripping

When opening files, strip any UTF-8 Byte Order Mark (`\uFEFF`) that Windows editors or cloud syncing tools may inject. If the file is not encrypted (e.g. unencrypted legacy format), return it directly:

```javascript
async function parseExport(text) {
  if (typeof text !== "string") return text;
  text = text.replace(/^\uFEFF/, "").trim();
  const envelope = JSON.parse(text);
  if (envelope.format !== EXPORT_MARKER) return envelope; // Legacy plain JSON

  const key = await getCryptoKey("decrypt");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeExportBytes(envelope.iv) },
    key,
    decodeExportBytes(envelope.data)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
```

---

## 3. Unified Data Schema

To make sync files and backup files **100% interchangeable**, both `buildSyncJSON()` and `exportAllFilesJSON()` construct the exact same object before encryption:

```javascript
const backup = {
  version: 2,
  exportedAt: new Date().toISOString(),
  syncMeta: {
    schemaVersion: 2,
    revision: 1,                          // Monotonic integer counter
    timestamp: Date.now(),
    deviceId: getDeviceId(),              // Persistent UUID stored in localStorage
    deviceName: getDeviceName(),          // e.g. "Mac - Chrome"
    contentHash: contentHash,             // SHA-256 of canonical data
    summary: {
      itemCount: items.length,
      folderCount: folders.length,
      totalRecords: totalRecords
    }
  },
  activeId: getActiveId(),
  items: items,
  folders: folders,
  // Legacy single-item fields for backwards compatibility
  legacyFields: ...
};
```

---

## 4. Change Detection & Fast Hashing

A key challenge in client-side sync is knowing whether local data changed without constantly running expensive SHA-256 operations on every keystroke.

### 4.1 Canonical Representation

Object keys can be serialized in different orders across platforms. To produce deterministic hashes:
1. Sort entity lists by their unique ID.
2. Produce a normalized JSON representation with only content properties.

```javascript
function getCanonicalData(items = null, folders = null) {
  const rawItems = items || getAllItems();
  const rawFolders = folders || getAllFolders();

  const cleanItems = [...rawItems].sort((a, b) => a.id.localeCompare(b.id)).map(item => ({
    id: item.id,
    name: item.name || "",
    folderId: item.folderId || null,
    records: [...(item.records || [])].sort((a, b) => a.id.localeCompare(b.id)),
    updatedAt: item.updatedAt || 0
  }));

  const cleanFolders = [...rawFolders].sort((a, b) => a.id.localeCompare(b.id)).map(f => ({
    id: f.id,
    name: f.name || "",
    parentId: f.parentId || null
  }));

  return { items: cleanItems, folders: cleanFolders };
}
```

### 4.2 Fast Synchronous Hash vs Cryptographic Hash

* **Fast Hash (Sync)**: Uses DJB2 (or FNV-1a) to compute a 32-bit hash in `< 1ms`. Call this on every `input` or state change to detect if the local state has returned to the synced base state.
* **Cryptographic Hash (Async)**: Uses `crypto.subtle.digest("SHA-256")`. Computed only during actual sync and backup generation.

```javascript
function computeDataHashSync(canonicalData) {
  const str = JSON.stringify(canonicalData);
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

async function computeDataHash(canonicalData) {
  const str = JSON.stringify(canonicalData);
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}
```

---

## 5. Storage: Storing File Handles in IndexedDB

The File System Access API provides a `FileSystemFileHandle`. While `localStorage` can only store strings, **IndexedDB can store serializable structured clones, including `FileSystemHandle` objects.**

```javascript
const SYNC_DB_NAME = "MyAppSyncDB";
const SYNC_DB_STORE = "sync_handles";
const SYNC_HANDLE_KEY = "activeSyncHandle";

function openSyncDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SYNC_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SYNC_DB_STORE)) {
        req.result.createObjectStore(SYNC_DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSyncHandle() {
  try {
    const db = await openSyncDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SYNC_DB_STORE, "readonly");
      const req = tx.objectStore(SYNC_DB_STORE).get(SYNC_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(tx.error);
    });
  } catch (e) {
    return null;
  }
}

async function setSyncHandle(handle) {
  const db = await openSyncDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_DB_STORE, "readwrite");
    tx.objectStore(SYNC_DB_STORE).put(handle, SYNC_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearSyncHandle() {
  const db = await openSyncDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_DB_STORE, "readwrite");
    tx.objectStore(SYNC_DB_STORE).delete(SYNC_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

---

## 6. The Sync Decision Engine

When synchronization runs, it compares:
1. **`localHash`**: SHA-256 of current canonical local data.
2. **`fileHash`**: SHA-256 of canonical data parsed from the file.
3. **`baseHash`**: SHA-256 recorded when this device last completed a sync.
4. **`baseRev` vs `fileRevision`**: Monotonic revision counters.

### 6.1 Decision Matrix

| Condition | Local Changed? | File Changed? | Action |
| :--- | :--- | :--- | :--- |
| `localHash === fileHash` | No | No | **Already in sync**: Update timestamp, exit. |
| Initial setup (one side empty) | Local has data | File is empty | **Push local to file** (Revision 1). |
| Initial setup (one side empty) | Local is empty | File has data | **Pull file to local**. |
| `localHash === baseHash && fileHash !== baseHash` | No | Yes | **Pull from file**: Apply data silently. |
| `localHash !== baseHash && fileHash === baseHash` | Yes | No | **Push to file**: Increment revision and write. |
| `localHash !== baseHash && fileHash !== baseHash` | Yes | Yes | **True Conflict**: Open visual Conflict Modal. |

```javascript
async function executeSyncResolution({ parsed, file, handle = null, isFirstSetup = false, onPushRequired = null }) {
  const meta = getSyncMeta();
  const localCanonical = getCanonicalData();
  const localHash = await computeDataHash(localCanonical);

  const fileCanonical = parsed?.items ? getCanonicalData(parsed.items, parsed.folders || []) : null;
  const fileHash = fileCanonical ? await computeDataHash(fileCanonical) : null;
  const fileMeta = parsed?.syncMeta || null;
  const fileRevision = Number.isFinite(fileMeta?.revision) ? fileMeta.revision : 1;
  const fileName = file?.name || meta.fileName || "sync_data.json";

  // Case 0: Hashes identical
  if (fileHash && localHash === fileHash) {
    setSyncMeta({
      fileName,
      lastSyncedRevision: fileRevision,
      lastSyncedContentHash: localHash,
      baseRevision: fileRevision,
      baseContentHash: localHash,
      baseFastHash: computeDataHashSync(localCanonical),
      lastSyncedAt: Date.now()
    });
    return;
  }

  const baseHash = meta.baseContentHash || null;
  const localChanged = baseHash ? (localHash !== baseHash) : true;
  const fileChanged = baseHash ? (fileHash !== baseHash) : true;

  if (!localChanged && fileChanged) {
    // Silent Pull
    applySyncData(parsed);
    setSyncMeta({
      fileName,
      baseRevision: fileRevision,
      baseContentHash: fileHash,
      baseFastHash: computeDataHashSync(fileCanonical),
      lastSyncedAt: Date.now()
    });
  } else if (localChanged && !fileChanged) {
    // Silent Push
    const nextRev = (meta.baseRevision || 0) + 1;
    if (handle) await pushToHandle(handle, nextRev);
    else if (onPushRequired) await onPushRequired(nextRev);
  } else {
    // Conflict Modal
    const localFP = generateDataFingerprint();
    const fileFP = generateDataFingerprint(parsed);
    const comparison = compareFingerprints(localFP, fileFP);
    openSyncConflictModal(comparison, async (choice) => {
      if (choice === "file") {
        applySyncData(parsed);
      } else {
        const nextRev = Math.max(fileRevision, meta.baseRevision || 0) + 1;
        if (handle) await pushToHandle(handle, nextRev);
        else if (onPushRequired) await onPushRequired(nextRev);
      }
    });
  }
}
```

---

## 7. Fingerprinting & Difference Engine

The fingerprinting engine summarizes dataset state and pinpoints exact additions, removals, and modifications between datasets.

### 7.1 Generating a Fingerprint

```javascript
function generateDataFingerprint(data = null) {
  const items = data ? (data.items || []) : getAllItems();
  const folders = data ? (data.folders || []) : getAllFolders();

  const itemSummary = items.map(item => ({
    id: item.id,
    name: item.name || "Untitled",
    recordCount: (item.records || []).length,
    updatedAt: item.updatedAt || 0
  }));

  return {
    timestamp: data?.exportedAt ? new Date(data.exportedAt).getTime() : (data?.syncMeta?.timestamp || Date.now()),
    itemCount: items.length,
    folderCount: folders.length,
    items: itemSummary,
    totalRecords: items.reduce((sum, item) => sum + (item.records || []).length, 0)
  };
}
```

### 7.2 Comparing Fingerprints

> [!CAUTION]
> Always attach the actual `items` array to difference objects. Do not just attach a text description; otherwise, modal templates that iterate over `diff.items.forEach(...)` will throw a fatal `TypeError`.

```javascript
function compareFingerprints(localFP, fileFP) {
  if (!localFP || !fileFP) return null;
  const differences = [];

  const localMap = new Map((localFP.items || []).map(t => [t.id, t]));
  const fileMap = new Map((fileFP.items || []).map(t => [t.id, t]));

  // New in file
  const newInFile = (fileFP.items || []).filter(t => !localMap.has(t.id));
  if (newInFile.length > 0) {
    differences.push({
      type: "newItems",
      description: `New item(s): ${newInFile.map(t => t.name).join(", ")}`,
      items: newInFile
    });
  }

  // Removed from local
  const onlyInLocal = (localFP.items || []).filter(t => !fileMap.has(t.id));
  if (onlyInLocal.length > 0) {
    differences.push({
      type: "removedItems",
      description: `Item(s) only in local data: ${onlyInLocal.map(t => t.name).join(", ")}`,
      items: onlyInLocal
    });
  }

  // Modified items
  const modified = [];
  (localFP.items || []).forEach(localItem => {
    const fileItem = fileMap.get(localItem.id);
    if (fileItem) {
      const changes = [];
      if (localItem.name !== fileItem.name) changes.push(`Name changed`);
      if (localItem.recordCount !== fileItem.recordCount) changes.push(`Records: ${localItem.recordCount} vs ${fileItem.recordCount}`);
      if (changes.length > 0) {
        modified.push({ name: localItem.name, changes });
      }
    }
  });

  if (modified.length > 0) {
    differences.push({
      type: "modifiedItems",
      description: `${modified.length} item(s) modified`,
      items: modified
    });
  }

  return { differences, hasDifferences: differences.length > 0 };
}
```

---

## 8. Backup & Restore Flow

### 8.1 Exporting (Create Backup File)

Exporting simply calls `buildSyncJSON()`, ensuring complete interchangeability:

```javascript
async function exportAllFilesJSON() {
  saveData();
  const meta = getSyncMeta();
  const revision = Number.isFinite(meta.baseRevision) ? meta.baseRevision : 1;
  const { jsonStr } = await buildSyncJSON(revision);
  const jsonFilename = `backup_${getExportTimestamp()}.json`;

  // Native Mobile Share Sheet (iOS / Android / Safari)
  if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try {
      const blob = new Blob([jsonStr], { type: "application/json" });
      const file = new File([blob], jsonFilename, { type: "application/json" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (e) { /* user cancelled or share failed */ }
  }

  saveFileAs(jsonStr, jsonFilename, "application/json");
}
```

### 8.2 Restoring (Restore Backup File)

```javascript
async function restoreFromBackup(event) {
  const file = event.target.files[0];
  event.target.value = ""; // Reset input so same file can be selected again
  if (!file) return;

  try {
    const text = await file.text();
    const data = await parseExport(text);

    if (data.version === 2 && Array.isArray(data.items)) {
      openRestoreChoiceModal(data);
    } else {
      showModal("Invalid backup file format.");
    }
  } catch (err) {
    console.error("[Restore] Error:", err);
    showModal("Error reading backup file.");
  }
}
```

### 8.3 Restore Options: Replace All vs Import New

The restore modal presents two distinct choices:
1. **Replace All Data**: Wipes local data and completely loads the file. If the file has `syncMeta`, it updates `lastSyncedContentHash` and `baseRevision` so subsequent syncs do not detect false conflicts.
2. **Import New Items**: Reads the incoming IDs and merges only entities that do not already exist in the local dataset.

---

## 9. Cross-Browser & Platform Quirks

### 9.1 Chrome & Arc vs Safari & Brave

| Browser | File System Access API | Background Disk Sync | Why? |
| :--- | :--- | :--- | :--- |
| **Chrome / Edge / Arc** | Supported | **Yes** | Fully implements FSA; serializes `FileSystemFileHandle` into IndexedDB. |
| **Safari** | Not Supported | **No (Manual)** | WebKit formally opposes FSA for user files on privacy/security grounds. Requires `<input type="file">`. |
| **Brave** | Supported | **Configurable** | Brave Shields blocks/wipes persistent disk handles in IndexedDB by default as an anti-fingerprinting measure. |

### 9.2 Handling Brave

In Brave, Chromium's **File System Access API is disabled by default** behind an internal browser flag for privacy protection. Even if the standard setting is toggled to "Sites can ask to edit files and folders", the browser completely omits `window.showOpenFilePicker` unless the underlying flag is enabled:
1. Navigate to: `brave://flags/#file-system-access-api`
2. Change the dropdown from "Default" to **Enabled**.
3. Relaunch Brave.
4. Brave will now support `window.showOpenFilePicker`, show the permission popup on first sync, and persist the handle in IndexedDB across sessions just like Chrome and Arc.

### 9.3 Windows UTF-8 BOM

Windows PowerShell, Notepad, and certain text utilities often prefix exported files with bytes `EF BB BF` (`\uFEFF`). `JSON.parse` in V8/WebKit will throw:
```
SyntaxError: Unexpected token '﻿', "﻿{..." is not valid JSON
```
**Fix:** Always strip BOM before parsing:
```javascript
text = text.replace(/^\uFEFF/, "").trim();
```

---

## 10. Reference Implementation

Here are the complete, production-ready modules to drop into your application:

```javascript
// ================= MODULE 1: CRYPTO & ENCODING =================
const EXPORT_KEY = "MyApp export key v1 - casual privacy only";
const EXPORT_MARKER = "myapp-encrypted-v1";

function encodeExportBytes(bytes) {
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function decodeExportBytes(value) {
  const cleanB64 = (value || "").replace(/\s+/g, "");
  const binary = atob(cleanB64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encryptExport(data) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(EXPORT_KEY));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return JSON.stringify({
    format: EXPORT_MARKER,
    iv: encodeExportBytes(iv),
    data: encodeExportBytes(new Uint8Array(ciphertext))
  }, null, 2);
}

async function parseExport(text) {
  if (typeof text !== "string") return text;
  text = text.replace(/^\uFEFF/, "").trim();
  const envelope = JSON.parse(text);
  if (envelope.format !== EXPORT_MARKER) return envelope;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(EXPORT_KEY));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeExportBytes(envelope.iv) },
    key,
    decodeExportBytes(envelope.data)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ================= MODULE 2: SAVE FILE HELPER =================
async function saveFileAs(content, defaultFilename, mimeType = "application/json") {
  if (window.showSaveFilePicker) {
    try {
      const ext = defaultFilename.split(".").pop();
      const handle = await window.showSaveFilePicker({
        suggestedName: defaultFilename,
        types: [{ description: "File", accept: { [mimeType]: ["." + ext] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(typeof content === "string" ? content : JSON.stringify(content));
      await writable.close();
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  // Fallback (Firefox, Safari, mobile)
  const str = typeof content === "string" ? content : JSON.stringify(content);
  const blob = new Blob([str], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```
