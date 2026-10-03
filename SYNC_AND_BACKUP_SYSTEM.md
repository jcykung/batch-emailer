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
6. **A warning bar when another machine got there first**: open the app on a second computer or browser and, if the browser's data differs from the sync file, a bar appears at the top of the screen saying which computer *and browser* last modified the file, with a **Sync Now** button right there. [→ §8](#8-the-external-update-warning-bar)
7. **Trust, but verify**: every file that gets written is read back and proven complete before it counts as saved, and storage-full errors, dead file handles and raw `DOMException`s become messages a person can act on. [→ §12](#12-guard-rails--hardening-in-this-app)
8. **Ready to reuse**: [§13](#13-porting-checklist-for-your-other-apps) is a rename-and-go checklist for rebuilding the sync & backup system of another one of your apps.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Envelope & Encryption Format](#2-data-envelope--encryption-format)
3. [Unified Data Schema](#3-unified-data-schema)
4. [Change Detection & Fast Hashing](#4-change-detection--fast-hashing)
5. [Storage: Storing File Handles in IndexedDB](#5-storage-storing-file-handles-in-indexeddb)
6. [The Sync Decision Engine](#6-the-sync-decision-engine)
7. [Device Identity & Sync Metadata](#7-device-identity--sync-metadata)
8. [The External-Update Warning Bar](#8-the-external-update-warning-bar)
9. [Fingerprinting & Difference Engine](#9-fingerprinting--difference-engine)
10. [Backup & Restore Flow](#10-backup--restore-flow)
11. [Cross-Browser & Platform Quirks](#11-cross-browser--platform-quirks)
12. [Guard Rails & Hardening](#12-guard-rails--hardening-in-this-app)
13. [Porting Checklist](#13-porting-checklist-for-your-other-apps)
14. [Reference Implementation (Copy-Paste Modules)](#14-reference-implementation)

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

> [!NOTE]
> **Before any of that runs**, the app checks the connected file for changes it did not write itself — on startup, on tab focus and on window focus. If the file has moved on, a **warning bar** drops in under the header naming the computer and browser that last modified it, with a **Sync Now** button (see [§8](#8-the-external-update-warning-bar)). The bar only *reports*; the decision engine above still decides between pull, push and conflict.

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
    deviceName: getDeviceName(),          // e.g. "MacBook · Chrome"
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

### 3.1 Three places data can live — and the rule for each

Decide *where* a piece of information goes before you write it. Getting this wrong is the #1 cause of phantom conflicts ("I only changed my theme and my laptop says the file disagrees").

| Lives | Examples | Rule |
| :--- | :--- | :--- |
| **In the file** | the real content: folders/groups/contacts, order and nesting, message history, settings | Travels to every device; restored by "Replace All Data". |
| **In the content hash** | those same content fields, canonicalised and sorted by id | Anything here **can cause a conflict**. Keep it to what the user would call "my data". |
| **Only in this browser** | device identity, theme, per-device orders (e.g. the Pinned list), collapsed/expanded state | Never enters the file and never enters the hash. |

How this app splits it:

* `batch-emailer-pinned-order` (the sidebar's Pinned drag order) is deliberately **per device** — reordering favourites on your laptop must not read as a data change on your desktop, and it is not part of the backup.
* `settings` (the theme) **is** written into the file so a restore brings it back, but is kept **out** of `contentHash`: a theme change alone can never trigger a sync conflict.
* `deviceId` / `deviceName` live in the `syncMeta` header only — they are *about* the file, not *in* it (see [§7](#7-device-identity--sync-metadata)).
* The canonical payload keeps only content fields (`id`, `name`, parent pointer, `updatedAt`, records sorted by id). Fields added later to your UI should not silently join the hash — that turns an upgrade into a one-time "conflict" on every machine.

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

### 5.1 Minimal version

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

### 5.2 The hardened version this app ships

The snippet above is enough for a greenfield app, but it breaks in exactly three ways that are painful to debug in production. This app's `src/syncStorage.js` handles all three:

**One database, several stores.**

```javascript
export const SYNC_DB_NAME    = "BatchEmailerSyncDB";
export const SYNC_DB_STORE   = "sync_handles";   // key: "activeSyncHandle"
export const AUTO_BACKUP_STORE = "auto_backups"; // keyPath: "id"
```

**1 · Migrate on upgrade, and repair a stale layout.** IndexedDB only runs an upgrade when the *version* changes. If an older build created the database at the same version you just opened, no upgrade runs, your new store never appears, and the first transaction throws *"One of the specified object stores was not found"*. So: create missing stores during `onupgradeneeded`, copy the legacy key across, and — after `onsuccess` — check that every required store actually exists, close, bump the version and reopen once:

```javascript
req.onsuccess = () => {
  const db = req.result;
  const missing = REQUIRED_STORES.filter(s => !db.objectStoreNames.contains(s));
  if (missing.length === 0) return succeed(watchConnection(db));

  db.close();
  if (allowRepair) {
    // An older build created this DB at this version, so no upgrade ran.
    openSyncDB({ version: Math.floor(db.version) + 1, allowRepair: false }).then(succeed, fail);
  } else {
    // Second attempt failed too: give an instruction instead of looping forever.
    fail(new Error("Sync storage is missing its data stores — clear this site's data, then import your backup again."));
  }
};
```

Never open with a version **lower** than the one already on disk — the browser rejects that with a `VersionError`. And delete the legacy store only *after* the copied handle has been written; a failed migration must never abort the upgrade.

**2 · Say why the database is busy.** `req.onblocked` fires when another tab holds an older version open. Turn it into a sentence: *"Sync storage is busy in another tab — close the other tabs of this app and try again."*

**3 · Assume the connection can die under you.** The browser may drop a cached connection; the next `db.transaction(...)` throws `InvalidStateError`. Wrap every call so it reopens once and retries:

```javascript
async function withSyncDB(fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openSyncDB();
    try {
      return await fn(db);
    } catch (error) {
      const stale = cachedConnection === db && error?.name === "InvalidStateError";
      if (!stale || attempt === 1) throw error;
      closeSyncDB(); // next loop reopens a fresh connection
    }
  }
}
```

Also register `db.onversionchange` / `db.onclose` to drop the cache and close — otherwise this tab blocks every other tab's upgrade forever.

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
| `localHash === baseHash && fileHash !== baseHash` | No | Yes | **Pull from file**: Apply data silently — *unless* the file has lost messages this device still holds, in which case fall through to conflict (see below). |
| `localHash !== baseHash && fileHash === baseHash` | Yes | No | **Push to file**: Increment revision and write. |
| `localHash !== baseHash && fileHash !== baseHash` | Yes | Yes | **True Conflict**: Open visual Conflict Modal — **Merge Both**, *Keep File*, or *Keep Local*. |

> [!IMPORTANT]
> **The pull guard: never pull a file that holds less history than you do.**
> "No local changes, the file moved on" is only safe while the file is a **superset** of what this device last synced. It stops being true the moment another device writes *less* to the file — a *Keep My Local Data* choice there, a partial write, a restored-elsewhere copy. A silent pull would then drop the messages this device still has, with no undo.
>
> So before pulling, the app counts messages that exist locally but are absent from the file, **for contacts present on both sides** (`countMessagesMissingFromFile`). Anything above zero falls through to the conflict dialog, which reports each side's message count and offers **Merge Both**. A contact the file does not have at all is deliberately *not* counted: that is a normal deletion, handled by ordinary sync, not lost history.

The conflict modal offers three resolutions, and the first one is the only one that cannot lose data:

1. **Merge Both — Keep Everything** → `mergeSyncData(local, file)`: folders and groups are unioned (local arrangement kept, file-only ones appended), contacts present on both sides go through `mergeContactRecords` so their histories are unioned too, and the result is pushed as a new revision. Nothing is discarded.
2. **Keep File Version** → replaces local state with the file. Local-only work is gone.
3. **Keep My Local Data** → overwrites the file. The other computer's file-only work is gone.

Options 2 and 3 say so in the confirmation, because they are destructive and the user has to be able to tell which one they just clicked.

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

## 7. Device Identity & Sync Metadata

Everything in this section exists so the app can answer three questions later: *who wrote this file?*, *has the file changed since we last looked?*, *are we the ones behind?* Those answers are what power the warning bar in [§8](#8-the-external-update-warning-bar).

### 7.1 Two identifiers, two jobs

```javascript
// 1. A stable id for this browser profile + origin — a UUID written once to
//    localStorage. It identifies an *install*, not a machine: clearing site
//    data creates a new one. Used to recognise "this file was written by us".
function getDeviceId() {
  let id = localStorage.getItem("yourapp-device-id");
  if (!id) {
    id = (typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : "dev-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
    localStorage.setItem("yourapp-device-id", id);
  }
  return id;
}

// 2. A human label *for the user*, written into syncMeta and shown in the
//    warning bar and the conflict modal: "MacBook · Chrome".
function getBrowserName() {
  const ua = navigator.userAgent;
  if (/Edg\//i.test(ua)) return "Edge";          // Edge also reports "Chrome/…"
  if (/OPR\/|Opera\//i.test(ua)) return "Opera"; // …and so does Opera
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua)) return "Safari";     // …and Chrome reports "Safari/…"
  return "Browser";
}

function getDeviceName() {
  const device = getDeviceModel();               // iPhone / iPad / MacBook / PC / …
  const browser = getBrowserName();
  return device ? `${device} · ${browser}` : browser;
}
```

> [!IMPORTANT]
> Check the user-agent masks **longest first**: Edge and Opera both advertise `Chrome/`, and Chrome advertises `Safari/`. A naive `if (ua.includes("Safari")) return "Safari"` labels every Chromium browser as Safari — in the message that tells your user which machine touched their file.
>
> `getDeviceName()` is **display only**. It goes into the `syncMeta` header and never into the canonical payload; otherwise every write from a new browser would look like a content change (see [§3](#3-unified-data-schema)).
>
> Files written by older builds carry just the machine (`MacBook`). The bar shows whatever the file holds, so there is nothing to migrate — the label only becomes more specific as devices rewrite the file.

### 7.2 The `syncMeta` store in localStorage

The file carries a `syncMeta` header; the browser keeps its own copy of the *same keys* so it can be compared without opening the file. One store, shallow-merged on every write:

```javascript
const SYNC_META_KEY = "yourapp-sync-meta";

function getSyncMeta() {
  try {
    const raw = localStorage.getItem(SYNC_META_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function setSyncMeta(updates) {
  const next = { ...getSyncMeta(), ...updates };
  localStorage.setItem(SYNC_META_KEY, JSON.stringify(next));
  return next;
}
```

| Key | Written when | Read to decide |
| :--- | :--- | :--- |
| `fileName` | a file is connected | "is sync configured at all?" |
| `lastSyncedAt` | a sync completes | compared with `file.lastModified` → "is the file newer?" |
| `lastSyncedContentHash` | a sync completes | SHA-256 test → "is the file *actually* different?" |
| `baseContentHash` | a sync completes | the **three-way base** of [§6](#6-the-sync-decision-engine) |
| `baseRevision` | a sync completes | monotonic counter feeding the push path |
| `baseFastHash` | a sync completes | "is the current state just what the last sync wrote?" (see §12.2) |
| `lastLocalChange` | every local edit | `lastLocalChange > lastSyncedAt` → "we owe a push" |
| `externalUpdateAvailable` / `externalUpdateAuthor` | the bar detects a remote edit | rebuild the warning bar after a reload (see §8.4) |

### 7.3 Name your copy

Prefix every key and DB with your app. Two apps served from the same origin share `localStorage` and IndexedDB — colliding on one key silently mixes two apps' data.

---

## 8. The External-Update Warning Bar

The most user-visible piece of this architecture: **open the app on a second computer or browser, and if what is on screen no longer matches the sync file, a bar appears directly under the header** saying which computer — and which browser — last modified the file, with a **Sync Now** button one click away.

```
┌────────────────────────────────────────────────────────────────┐
│  App header                                theme   Sync & Backup│
├────────────────────────────────────────────────────────────────┤
│  ⟳  "batch_sync.json" was updated on MacBook · Chrome —        │
│     click Sync Now to pull.         [ Sync Now ]          [ × ] │ ← warning bar
├────────────────────────────────────────────────────────────────┤
│                                                                │
│                          main content                          │
│                                                                │
```

### 8.1 It reports; it never decides

This is the decision worth copying. The bar knows exactly one thing: *"the file is ahead of us, and here is who wrote it."* Pressing **Sync Now** runs the normal decision engine ([§6](#6-the-sync-decision-engine)):

* no local edits → silent **pull** (skipped if the file has lost messages this device still has — see [§6.1](#61-decision-matrix)),
* only local edits → silent **push**,
* both sides changed → the **conflict modal** with a per-record diff, each side's message count, and a **Merge Both** option that keeps everything.

Never let a notification overwrite data. If a bar were allowed to "just take the file", one stray window-focus event while you are typing could wipe out unsaved work.

### 8.2 All four conditions must hold

```javascript
async function checkForExternalChanges() {
  if (!(window.showSaveFilePicker || window.showOpenFilePicker)) return; // 1. FSA only — see §11
  const meta = getSyncMeta();
  if (!meta.fileName) return;                                          // 2. a file is connected
  const handle = await getSyncHandle();                                // 3. a handle is stored
  if (!handle) return;
  if (await handle.queryPermission({ mode: "readwrite" }) !== "granted") return;

  const file = await handle.getFile();
  if (file.lastModified <= (meta.lastSyncedAt || 0)) return;           // 4a. newer than our last sync

  const parsed = await parseExport(await file.text());
  const fileHash = await computeDataHash(getCanonicalData(normalizeImportedData(parsed)));
  if (!fileHash || fileHash === meta.lastSyncedContentHash) return;    // 4b. actually different

  setSyncMeta({
    externalUpdateAvailable: true,
    externalUpdateAuthor: parsed.syncMeta?.deviceName || ""
  });
  const author = parsed.syncMeta?.deviceName ? ` on ${parsed.syncMeta.deviceName}` : "";
  setExternalBanner(`"${meta.fileName}" was updated${author} — click Sync Now to pull.`);
  setSyncStatus("external-update");
}
```

Condition **4b** is what keeps the bar honest: a file that was rewritten with *identical* content (an "already in sync" run, a cloud client re-saving it, an editor reformatting it) raises **no** warning. `file.lastModified` alone would cry wolf, and a warning people can't trust is worse than no warning.

### 8.3 When it looks

```javascript
useEffect(() => { initSync(); }, []);   // mount: rebuild from the stored flag, then check
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkForExternalChanges();
});
window.addEventListener("focus", checkForExternalChanges);
```

Returning to the tab after editing on another machine is enough — no refresh, no polling timer, no server.

### 8.4 The warning survives a reload

The flag and the author are stored in `syncMeta`, so on the next mount the bar is rebuilt *before* any file is read:

```javascript
if (meta.externalUpdateAvailable && currentFileName) {
  setSyncStatus("external-update");
  const author = meta.externalUpdateAuthor ? ` on ${meta.externalUpdateAuthor}` : "";
  setExternalBanner(`"${currentFileName}" was updated${author} — click Sync Now to pull.`);
}
```

Both are cleared the moment a sync actually runs, and re-set by whatever the engine finds. A dismissed-but-unsynced warning therefore comes back on the next visit — deliberately, because the difference is still there.

### 8.5 The markup

A full-width strip under the header — **not** a modal, so it never blocks work and never steals focus — with one primary button and a dismiss:

```jsx
{externalBanner && (
  <div className="px-4 py-2 text-xs font-semibold flex items-center justify-between border-b ...">
    <div className="flex items-center gap-2 truncate mr-2">
      <RefreshCw size={14} />
      <span className="truncate">{externalBanner}</span>
    </div>
    <div className="flex items-center gap-2 shrink-0">
      <button onClick={autoSync}>Sync Now</button>
      <button onClick={() => setExternalBanner(null)} title="Dismiss">×</button>
    </div>
  </div>
)}
```

Set the status to `external-update` at the same moment, so the Sync & Backup screen can say the same thing in full ("Another device updated the file…") alongside the two device labels in the conflict modal ([§9](#9-fingerprinting--difference-engine)).

### 8.6 Porting notes

* **This bar needs the File System Access API.** Only Chromium can silently re-open a file you connected earlier. On Safari/Firefox/mobile there is no handle to poll — do one of these instead of staying silent:
  * flag **your own** unsynced work with the same bar, different text ("You have changes that are not in the file yet"), and/or
  * show the same "updated on …" message when the user re-picks the file at sync time; the engine then pulls or conflicts as usual.
* Put the **file name** in the message (people run more than one), the writing **device + browser**, and the verb (`Sync Now`).
* If `queryPermission()` returns `"prompt"`, you cannot read the file yet — do **not** show the bar, it would promise information you don't have. Ask for permission from the Sync button instead.
* Clear both the stored flag and the visible strip when a sync runs. A bar that survives a successful sync teaches people to ignore it.

---

## 9. Fingerprinting & Difference Engine

The fingerprinting engine summarizes dataset state and pinpoints exact additions, removals, and modifications between datasets.

### 9.1 Generating a Fingerprint

> [!NOTE]
> **Count the messages, not just the records.** The fingerprint in this app also carries `messageCount: countEmailMessages(...)` per side, and `compareFingerprints()` emits an `Email messages: N local vs M in file` difference from it. A conflict dialog that only shows entity counts makes "which side do I keep?" a blind choice about the one thing users care about most. Message counts are cheap and make the trade-off visible before the click.

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

### 9.2 Comparing Fingerprints

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

## 10. Backup & Restore Flow

### 10.1 Exporting (Create Backup File)

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

### 10.2 Restoring (Restore Backup File)

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

### 10.3 Restore Options: Replace All vs Import New

The restore modal presents two distinct choices:
1. **Replace All Data**: Wipes local data and completely loads the backup. It deliberately does **not** touch the sync base — the restored content has *not* been written to the sync file, so recording it as "already synced" would make the next sync read local as unchanged and silently pull the file over it, wiping the history just restored. Instead it stamps `lastLocalChange`, leaving the data flagged as *unsynced edits* so the next sync pushes it (or opens the conflict dialog, which can merge). It also never renames the sync file after the backup it came from. Marking a restore as synced is the classic way a backup restore self-destructs on the next sync.
2. **Import New Items**: Reads the incoming IDs and merges only entities that do not already exist in the local dataset, and unions email histories for the ones that do (`mergeContactRecords`). It finishes with `noteLocalChange()` so the merged result is tracked as work to push rather than falling out of the change tracker.

---

## 11. Cross-Browser & Platform Quirks

### 11.1 Chrome & Arc vs Safari & Brave

| Browser | File System Access API | Background Disk Sync | Why? |
| :--- | :--- | :--- | :--- |
| **Chrome / Edge / Arc** | Supported | **Yes** | Fully implements FSA; serializes `FileSystemFileHandle` into IndexedDB. |
| **Safari** | Not Supported | **No (Manual)** | WebKit formally opposes FSA for user files on privacy/security grounds. Requires `<input type="file">`. |
| **Brave** | Supported | **Configurable** | Brave Shields blocks/wipes persistent disk handles in IndexedDB by default as an anti-fingerprinting measure. |

### 11.2 Handling Brave

In Brave, Chromium's **File System Access API is disabled by default** behind an internal browser flag for privacy protection. Even if the standard setting is toggled to "Sites can ask to edit files and folders", the browser completely omits `window.showOpenFilePicker` unless the underlying flag is enabled:
1. Navigate to: `brave://flags/#file-system-access-api`
2. Change the dropdown from "Default" to **Enabled**.
3. Relaunch Brave.
4. Brave will now support `window.showOpenFilePicker`, show the permission popup on first sync, and persist the handle in IndexedDB across sessions just like Chrome and Arc.

### 11.3 Windows UTF-8 BOM

Windows PowerShell, Notepad, and certain text utilities often prefix exported files with bytes `EF BB BF` (`\uFEFF`). `JSON.parse` in V8/WebKit will throw:
```
SyntaxError: Unexpected token '﻿', "﻿{..." is not valid JSON
```
**Fix:** Always strip BOM before parsing:
```javascript
text = text.replace(/^\uFEFF/, "").trim();
```

---

## 12. Guard Rails & Hardening in This App

Each item below is small, and each one exists because without it the system does something the user cannot undo.

### 12.1 Read every write back before trusting it

After building and encrypting a sync/backup file, the app decrypts **the string it just produced**, normalizes it, and compares the folder / group / contact / email-message counts (and the content hash) against what was meant to be written:

```javascript
async function verifyBackupRoundTrip(jsonStr, sourceData, sourceSettings) {
  const roundTrip = await parseExport(jsonStr);          // decrypt what we wrote
  const expected = getDataSummary(sourceData);           // counts we meant to store
  const actual = getDataSummary(normalizeImportedData(roundTrip));
  // …compare, then throw with a sentence a human can act on
}
```

Any mismatch throws and the save **fails loudly** instead of leaving a truncated file that silently becomes the new truth. When you port this, write a `verify…RoundTrip()` around *your* completeness counts.

### 12.2 A pull is not an edit

The effect that tracks local edits compares the fresh state with `baseFastHash` first:

```javascript
const matchesSyncedBase = !!meta.baseFastHash
  && computeDataHashSync(getCanonicalData(data)) === meta.baseFastHash;

if (matchesSyncedBase) {
  // This is the content a sync just wrote into app state — not an edit.
  // Drop a stale "unsynced edits" flag and report what is actually left.
} else {
  setSyncMeta({ lastLocalChange: Date.now() });
  setSyncStatus("local-changes");
}
```

Without this, a **pull** writes new content into state, the effect sees "changed", stamps `lastLocalChange` and lights the Sync button *after* a sync that already succeeded. The same trap sits in `autoSync()`'s `finally`: it only settles the status when it is still `'syncing'`, because the `data` captured there is the pre-pull copy.

### 12.3 "Do we owe a push?" in one function

```javascript
function syncNeedsPush(currentData) {
  if (!meta.fileName) return false;
  if ((meta.lastLocalChange || 0) > (meta.lastSyncedAt || 0)) return true;
  if (currentData && meta.baseFastHash
      && computeDataHashSync(getCanonicalData(currentData)) !== meta.baseFastHash) return true;
  return false;
}
```

It drives the status light, the status text, and the `beforeunload` guard that warns before you close a tab with unsynced work.

### 12.4 Storage failures are surfaced, never swallowed

A rejected `localStorage.setItem` means the newest edits — email messages included — live only until reload. The write helper forwards the error to state, and a dialog says exactly that, telling the user to download a backup now:

```javascript
const isQuota = e.name === "QuotaExceededError"
  || e.name === "NS_ERROR_DOM_QUOTA_REACHED"      // Firefox
  || e.name === "QUOTA_EXCEEDED_ERR"              // legacy WebKit
  || /quota|storage|exceed/i.test(e.message || ""); // engines that only set a message
```

The three spellings plus a text match are needed because engines disagree on how quota exhaustion is reported.

### 12.5 Errors are translated before they are shown

`describeSyncError()` turns IndexedDB/permission `DOMException`s into an instruction ("choose the file again", "reconnect"), and a dead file handle (renamed, moved, permission lost) is cleared automatically so the next sync re-picks the file instead of failing forever. A raw `e.message` is never the final UI.

### 12.6 An automatic browser backup on every change

### 12.6 An automatic backup history in the browser

Every change is also written to IndexedDB (`putAutoBackup`), so a user who never connects a file — or who loses history to a bad sync — still has points to come back to. Three decisions make it a safety net instead of a single record each save overwrites:

* **A rolling history, not one record.** Up to `AUTO_BACKUP_MAX_RECORDS` (12) snapshots are kept, and a save whose content hash matches the newest one is skipped, so the history holds distinct points in time rather than one entry per keystroke.
* **Slots that spread over time.** Pruning keeps the newest snapshot, then one snapshot per *widening* gap — 1, 3, 7, 15, 31 … minutes. Twelve slots therefore reach a few days back with no hole between them, where "the last 12 saves" would cover about a minute. The newest snapshot always survives, so pruning can never empty the store.
* **A restore that merges.** *Sync & Backup → Automatic Backups* decrypts a snapshot and feeds it through the same restore-choice modal as a file backup, so the default path unions histories instead of replacing them.

The hot path stays cheap: a save does one small `get` (a metadata record) plus two puts, and only reads the stored datasets back when the store has drifted past the cap plus a little slack. Snapshots live in this browser only — an exported backup file ([§10](#10-backup--restore-flow)) is still what moves them between machines.

### 12.7 Merge, don't overwrite, on import

"Import New Items Only" and the contact-level merge union the message histories and keep the newest subject/timestamp (`mergeContactRecords`) rather than skipping entities that exist on both sides. Two machines working on the same contact converge instead of one silently winning. The same rule applies to sync conflicts: `mergeSyncData()` unions folders, groups and contacts so **Merge Both** can resolve a conflict without discarding anything.

### 12.8 A conflict can always be merged, and a lossy pull is refused

Two moves keep history from disappearing between computers:

```javascript
// 1. The pull guard — refuse to silently replace local with a file that holds less.
if (fileChanged && !localChanged
    && countMessagesMissingFromFile(activeData, fileNormalized) === 0) {
  doPull();
  return;
}

// 2. The merge resolution — union both sides, then push the result.
const merged = mergeSyncData(data, syncConflictData.parsed);
setData(merged);
await pushToHandle(syncConflictData.handle, nextRev, merged);
```

`countMessagesMissingFromFile()` only counts messages missing from *contacts that exist on both sides* — a contact the file simply does not have is a normal deletion, not lost history. Keeping the guard that narrow means it never fires during an ordinary forward sync, so it stays trustworthy rather than becoming a prompt the user learns to dismiss.

### 12.9 Never resolve against a file you could not read

`readSyncFile()` leaves `parsed` as `null` when the text is not a valid Batch Emailer file (truncated write, wrong file picked in the dialog). Passing that into the decision engine would compute a `null` dataset and pull it into app state. The sync path therefore refuses first — `fileHasContent && !fileHasData` → error toast, stop — and an *empty* file is normalised to an empty dataset rather than to `null`.

### 12.10 Status is derived, never assumed

`idle | synced | local-changes | external-update | syncing | error` is recomputed from `syncMeta` after every operation, so a cancelled file picker, a permission denial or a conflict modal cannot leave a green light on.

### 12.11 Verification scripts — the part to copy first

`npm run verify` runs three Node scripts that bundle the app source with esbuild (JSX included), stub `localStorage` / `navigator` / `window` / `document`, and assert behaviour with no browser at all:

| Script | What it proves |
| :--- | :--- |
| `verify-backup` | file round-trip, hashes, counts, order & nesting, import merge, conflict merge, pull guard, backup-history pruning |
| `verify-import` | contact-import parsers and the review step |
| `verify-sidebar` | server-rendered sidebar, drag-order helpers, and that the **shipped bundle** still contains the handlers/menus |

They finish in about a second, which is why the sync logic can be changed confidently. When you port the architecture, port the harness as well as the code.

---

## 13. Porting Checklist for Your Other Apps

### 13.1 The rename table

| Thing | In this app | What to change |
| :--- | :--- | :--- |
| `localStorage` prefix | `batch-emailer-*` (`theme`, `device-id`, `sync-meta`, `pinned-order`) | your prefix — same-origin apps share storage |
| IndexedDB | db `BatchEmailerSyncDB`, stores `sync_handles` + `auto_backups` | unique DB/store names (§5.2 covers migration & repair) |
| Encryption | `EXPORT_KEY` passkey + `EXPORT_MARKER` (`…-encrypted-v1`) | unique key **and** marker; the marker stops a foreign file being parsed as yours |
| Canonical payload | `getCanonicalData()` → folders / groups / contacts + their order | your content entities, sorted by id, content fields only |
| File payload | `buildBackupPayload()` → `folders`, `classes`, `students`, `settings` + `syncMeta` | your entities; keep the `syncMeta` shape identical |
| Completeness counts | `getDataSummary()` / `describeDataSummary()` (…`messageCount`) | counts that prove *your* file is complete |
| Fingerprint & diff | `generateDataFingerprint()` / `compareFingerprints()` | name + count + `updatedAt` per entity, and attach the **real arrays** |
| Device identity | `getDeviceId()` / `getDeviceName()` | same code, different keys |
| Default file name | `batch_emailer_sync.json` | yours |
| UI copy | "Sync Now", status texts, conflict modal labels | your app's nouns |

### 13.2 Order of work

1. **Pure core first** — crypto encode/decode, canonicalisation, fast + cryptographic hashes — with a Node unit test.
2. **`syncMeta` + device identity** — one localStorage store, the keys in [§7.2](#72-the-syncmeta-store-in-localstorage).
3. **Decision engine** — implement the [§6](#6-the-sync-decision-engine) matrix, one fixture per row.
4. **Round-trip verification** — write, read back, compare counts — *before* adding features.
5. **Warning bar** — [§8](#8-the-external-update-warning-bar): detect on mount/focus, persist the flag, define the non-FSA fallback.
6. **Guard rails** — quota, error translation, `beforeunload`, derived status (§12).
7. **Regression scripts** — bundle + stub + assert, wired to one `npm run verify` command.

### 13.3 Easy ways to get it wrong

* Hashing anything that is not content — a device name, a per-save timestamp, a per-device order — makes every machine permanently disagree.
* Trusting `file.lastModified` alone; always **also** compare a content hash.
* Clearing the "external update" flag before a sync has actually run (or never clearing it).
* Keeping per-device UI state in the file, so a drag reorder on one device becomes a conflict on another.
* Auto-applying a file because a notification appeared — the bar reports, the engine decides.
* Forgetting the BOM strip / line-ending normalisation before `JSON.parse` ([§11.3](#113-windows-utf-8-bom)).
* Offering only *keep mine* / *keep theirs* on a conflict: one careless click discards the other machine's history and there is no undo. Ship a **Merge Both**, and show each side's message count so the choice is not blind.
* Marking a restore-from-backup as *already synced*. The base then describes content that was never written to the sync file, so the next sync reads local as unchanged and silently pulls the file over it — the restored history is gone one sync later.
* Pulling `parsed === null` into app state because a file failed to parse.
* Keeping a single auto-backup record that every change overwrites: it looks like a safety net but never survives the incident it was meant to cover.

---

## 14. Reference Implementation

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
